// src/modules/payments/routes.js
import { InstallmentStatus, ContractStatus } from "@prisma/client";

export default async function routes(app) {
  const canRead = { preHandler: [app.verifyJwt, app.authorize("payments", "read")] };
  const canCreate = { preHandler: [app.verifyJwt, app.authorize("payments", "create")] };
  const canDelete = { preHandler: [app.verifyJwt, app.authorize("payments", "delete")] };
  const schema = {
    tags: ["payments"]
  };
  const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };

  async function recalcInstallmentAndContract(tx, installmentId) {
    const inst = await tx.installment.findUnique({
      where: { id: installmentId },
      include: { contract: true }
    });
    if (!inst) return null;

    // قسط
    let next = InstallmentStatus.PENDING;
    if (inst.paidCents >= inst.amountCents) next = InstallmentStatus.PAID;
    else if (inst.dueDate < new Date()) next = InstallmentStatus.LATE;
    if (next !== inst.status) {
      await tx.installment.update({ where: { id: inst.id }, data: { status: next } });
    }

    // عقد
    const insts = await tx.installment.findMany({ where: { contractId: inst.contractId } });
    const allPaid = insts.every((i) => i.paidCents >= i.amountCents);
    const anyLateUnpaid = insts.some((i) => i.dueDate < new Date() && i.paidCents < i.amountCents);
    const newStatus = allPaid ? ContractStatus.CLOSED : anyLateUnpaid ? ContractStatus.DEFAULTED : ContractStatus.ACTIVE;
    if (newStatus !== inst.contract.status) {
      await tx.contract.update({ where: { id: inst.contractId }, data: { status: newStatus } });
    }

    return { installmentId: inst.id, contractId: inst.contractId };
  }

  // ---------- GET /payments ----------
  app.get(
    "/payments",
    {
      ...canRead,
      schema: {
        ...schema,
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            installmentId: { type: "integer", nullable: true },
            contractId: { type: "integer", nullable: true },
            customerId: { type: "integer", nullable: true }
          }
        }
      }
    },
    async (req) => {
      const page = toInt(req.query.page, 1);
      const pageSize = toInt(req.query.pageSize, 20);
      const { installmentId, contractId, customerId } = req.query;

      const where = {};
      if (installmentId) where.installmentId = Number(installmentId);
      if (contractId) where.installment = { contractId: Number(contractId) };
      if (customerId) where.installment = { contract: { customerId: Number(customerId) } };

      const [items, total] = await app.prisma.$transaction([
        app.prisma.payment.findMany({
          where,
          orderBy: { paidAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            installment: {
              include: {
                contract: {
                  include: { customer: { select: { id: true, name: true, phone: true } } }
                }
              }
            }
          }
        }),
        app.prisma.payment.count({ where })
      ]);

      return { page, pageSize, total, items };
    }
  );

  // ---------- GET /payments/:id ----------
  app.get("/payments/:id", { ...canRead, schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } }, async (req, reply) => {
    const id = toInt(req.params.id);
    const payment = await app.prisma.payment.findUnique({
      where: { id },
      include: {
        installment: {
          include: {
            contract: {
              include: { customer: { select: { id: true, name: true, phone: true } } }
            }
          }
        }
      }
    });
    if (!payment) return reply.error(404, "Payment not found");
    return payment;
  });

  // ---------- POST /payments ----------
  app.post(
    "/payments",
    {
      ...canCreate,
      schema: {
        ...schema,
        body: {
          type: "object",
          required: ["installmentId", "amountCents"],
          properties: {
            installmentId: { type: "integer" },
            amountCents: { type: "integer", minimum: 1 },
            paidAt: { type: "string", format: "date-time", nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const { installmentId, amountCents, paidAt } = req.body;
      const now = paidAt ? new Date(paidAt) : new Date();

      return app.prisma.$transaction(async (tx) => {
        const inst = await tx.installment.findUnique({ where: { id: installmentId } });
        if (!inst) return reply.error(404, "Installment not found");

        const remaining = Math.max(inst.amountCents - inst.paidCents, 0);
        if (remaining === 0) {
          return reply.error(400, "Installment already fully paid");
        }

        const apply = Math.min(amountCents, remaining);

        const payment = await tx.payment.create({
          data: { installmentId, amountCents: apply, paidAt: now }
        });

        await tx.installment.update({
          where: { id: installmentId },
          data: { paidCents: { increment: apply } }
        });

        await recalcInstallmentAndContract(tx, installmentId);

        return { payment, appliedCents: apply, leftoverCents: amountCents - apply };
      });
    }
  );

  // ---------- DELETE /payments/:id ----------
  app.delete("/payments/:id", { ...canDelete, schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } }, async (req, reply) => {
    const id = toInt(req.params.id);
    return app.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) return reply.error(404, "Payment not found");

      // رجّع المبلغ إلى القسط
      await tx.installment.update({
        where: { id: payment.installmentId },
        data: { paidCents: { decrement: payment.amountCents } }
      });

      await tx.payment.delete({ where: { id } });
      await recalcInstallmentAndContract(tx, payment.installmentId);

      return { ok: true };
    });
  });
}
