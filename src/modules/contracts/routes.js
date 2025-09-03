// src/modules/contracts/routes.js
import { ContractStatus, InstallmentStatus } from "@prisma/client";

export default async function routes(app) {
  const canRead = { preHandler: [app.verifyJwt, app.authorize("contracts", "read")] };
  const canCreate = { preHandler: [app.verifyJwt, app.authorize("contracts", "create")] };
  const canUpdate = { preHandler: [app.verifyJwt, app.authorize("contracts", "update")] };
  const canDelete = { preHandler: [app.verifyJwt, app.authorize("contracts", "delete")] };
  const schema = {
    tags: ["contracts"]
  };

  const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  const addMonths = (d, m) => new Date(d.getFullYear(), d.getMonth() + m, d.getDate());

  function splitInstallments(total, months) {
    const base = Math.floor(total / months);
    const rest = total - base * months;
    return Array.from({ length: months }, (_, i) => base + (i === 0 ? rest : 0));
  }

  async function recalcContractStatus(tx, contractId) {
    const insts = await tx.installment.findMany({ where: { contractId } });
    const allPaid = insts.every((i) => i.paidCents >= i.amountCents);
    const anyLateUnpaid = insts.some((i) => i.dueDate < new Date() && i.paidCents < i.amountCents);
    const newStatus = allPaid ? ContractStatus.CLOSED : anyLateUnpaid ? ContractStatus.DEFAULTED : ContractStatus.ACTIVE;
    await tx.contract.update({ where: { id: contractId }, data: { status: newStatus } });
    return newStatus;
  }

  // ---------- GET /contracts ----------
  app.get(
    "/contracts",
    {
      ...canRead,
      schema: {
        ...schema,
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            customerId: { type: "integer", nullable: true },
            status: { type: "string", enum: Object.values(ContractStatus), nullable: true }
          }
        }
      }
    },
    async (req) => {
      const page = toInt(req.query.page, 1);
      const pageSize = toInt(req.query.pageSize, 20);
      const { customerId, status } = req.query;

      const where = {};
      if (customerId) where.customerId = Number(customerId);
      if (status) where.status = status;

      const [items, total] = await app.prisma.$transaction([
        app.prisma.contract.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize > 1000 ? 1000 : pageSize,
          include: {
            customer: { select: { id: true, name: true, phone: true } },
            _count: { select: { items: true, installments: true } }
          }
        }),
        app.prisma.contract.count({ where })
      ]);

      return { page, pageSize, total, items };
    }
  );

  // ---------- GET /contracts/:id ----------
  app.get("/contracts/:id", { ...canRead, schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } }, async (req, reply) => {
    const id = toInt(req.params.id);
    const contract = await app.prisma.contract.findUnique({
      where: { id },
      include: {
        customer: true,
        items: { include: { product: true } },
        installments: { orderBy: { seq: "asc" }, include: { payments: true } }
      }
    });
    if (!contract) return reply.error(404, "Contract not found");
    return contract;
  });

  // ---------- POST /contracts ----------
  app.post(
    "/contracts",
    {
      ...canCreate,
      schema: {
        ...schema,
        body: {
          type: "object",
          required: ["customerId", "items", "months", "startDate"],
          properties: {
            customerId: { type: "integer" },
            months: { type: "integer", minimum: 1 },
            startDate: { type: "string", format: "date-time" },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["productId", "qty"],
                properties: {
                  productId: { type: "integer" },
                  qty: { type: "integer", minimum: 1 }
                }
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const { customerId, months, startDate, items } = req.body;

      return app.prisma.$transaction(async (tx) => {
        const prods = await tx.product.findMany({ where: { id: { in: items.map((i) => i.productId) } } });
        if (prods.length !== items.length) return reply.error(400, "Invalid product(s)");

        const norm = items.map((i) => {
          const p = prods.find((pp) => pp.id === i.productId);
          return { productId: p.id, qty: i.qty, unitCents: p.priceCents };
        });
        const totalCents = norm.reduce((s, i) => s + i.unitCents * i.qty, 0);

        for (const it of norm) {
          await tx.product.update({
            where: { id: it.productId },
            data: { stock: { decrement: it.qty } }
          });
        }

        const contract = await tx.contract.create({
          data: { customerId, totalCents, months, startDate: new Date(startDate), status: ContractStatus.ACTIVE, items: { create: norm } }
        });

        const amounts = splitInstallments(totalCents, months);
        for (let i = 0; i < months; i++) {
          await tx.installment.create({
            data: {
              contractId: contract.id,
              seq: i + 1,
              dueDate: addMonths(new Date(startDate), i),
              amountCents: amounts[i],
              status: InstallmentStatus.PENDING,
              paidCents: 0
            }
          });
        }

        return contract;
      });
    }
  );

  // ---------- PATCH /contracts/:id/status ----------
  app.patch(
    "/contracts/:id/status",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        body: { type: "object", required: ["status"], properties: { status: { type: "string", enum: Object.values(ContractStatus) } } }
      }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      try {
        return await app.prisma.contract.update({ where: { id }, data: { status: req.body.status } });
      } catch {
        return reply.error(404, "Contract not found");
      }
    }
  );

  // ---------- POST /contracts/:id/recalc ----------
  app.post("/contracts/:id/recalc", { ...canUpdate, schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } }, async (req, reply) => {
    const id = toInt(req.params.id);
    const contract = await app.prisma.contract.findUnique({ where: { id } });
    if (!contract) return reply.error(404, "Contract not found");

    await app.prisma.$transaction(async (tx) => {
      const insts = await tx.installment.findMany({ where: { contractId: id } });
      for (const inst of insts) {
        let status = InstallmentStatus.PENDING;
        if (inst.paidCents >= inst.amountCents) status = InstallmentStatus.PAID;
        else if (inst.dueDate < new Date()) status = InstallmentStatus.LATE;
        if (status !== inst.status) {
          await tx.installment.update({ where: { id: inst.id }, data: { status } });
        }
      }
      await recalcContractStatus(tx, id);
    });

    return app.prisma.contract.findUnique({ where: { id }, include: { installments: true } });
  });

  // ---------- DELETE /contracts/:id ----------
  app.delete("/contracts/:id", { ...canDelete, schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } }, async (req, reply) => {
    const id = toInt(req.params.id);
    const contract = await app.prisma.contract.findUnique({
      where: { id },
      include: { _count: { select: { installments: true } } }
    });
    if (!contract) return reply.error(404, "Contract not found");
    if (contract._count.installments > 0) {
      return reply.error(409, "Cannot delete contract with installments");
    }
    await app.prisma.contract.delete({ where: { id } });
    return { ok: true };
  });
}
