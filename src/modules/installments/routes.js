// src/modules/installments/routes.js
export default async function routes(app) {
  // لو عندك JWT:
  const canRead = { preHandler: [app.verifyJwt, app.authorize("installments", "read")] };
  const canUpdate = { preHandler: [app.verifyJwt, app.authorize("installments", "update")] };
  const canCreatePay = { preHandler: [app.verifyJwt, app.authorize("payments", "create")] };
  const schema = {
    tags: ["installments"]
  };

  // ---------- helpers ----------
  const InstallmentStatus = {
    PENDING: "PENDING",
    PAID: "PAID",
    LATE: "LATE"
  };
  const ContractStatus = {
    ACTIVE: "ACTIVE",
    CLOSED: "CLOSED",
    DEFAULTED: "DEFAULTED"
  };

  async function recalcInstallmentStatus(inst) {
    const now = new Date();
    if (inst.paidCents >= inst.amountCents) return InstallmentStatus.PAID;
    if (inst.dueDate < now) return InstallmentStatus.LATE;
    return InstallmentStatus.PENDING;
  }

  async function recalcContractStatus(tx, contractId) {
    const items = await tx.installment.findMany({ where: { contractId } });
    const allPaid = items.every((i) => i.paidCents >= i.amountCents);
    const anyLateUnpaid = items.some((i) => i.dueDate < new Date() && i.paidCents < i.amountCents);
    const status = allPaid ? ContractStatus.CLOSED : anyLateUnpaid ? ContractStatus.DEFAULTED : ContractStatus.ACTIVE;
    await tx.contract.update({ where: { id: contractId }, data: { status } });
    return status;
  }

  // ---------- GET /installments ----------
  app.get(
    "/",
    {
      ...canRead,
      schema: {
        ...schema,
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            status: { type: "string", enum: Object.values(InstallmentStatus), nullable: true },
            contractId: { type: "integer", nullable: true },
            customerId: { type: "integer", nullable: true },
            dueFrom: { type: "string", format: "date-time", nullable: true },
            dueTo: { type: "string", format: "date-time", nullable: true },
            overdueOnly: { type: "boolean", nullable: true },
            sort: { type: "string", enum: ["dueDate:asc", "dueDate:desc", "seq:asc", "seq:desc"], default: "dueDate:asc" }
          }
        }
      }
    },
    async (req) => {
      const { page = 1, pageSize = 20, status, contractId, customerId, dueFrom, dueTo, overdueOnly, sort = "dueDate:asc" } = req.query;

      const where = {};
      if (status) where.status = status;
      if (contractId) where.contractId = Number(contractId);
      if (dueFrom || dueTo) {
        where.dueDate = {};
        if (dueFrom) where.dueDate.gte = new Date(dueFrom);
        if (dueTo) where.dueDate.lte = new Date(dueTo);
      }
      if (overdueOnly) {
        // متأخر وغير مدفوع بالكامل
        where.AND = [
          ...(where.AND || []),
          { dueDate: { lt: new Date() } },
          { paidCents: { lt: app.prisma.installment.fields.amountCents } } // hack-y, فبدالها نضيف شرط يدوي بعدين
        ];
      }
      if (customerId) {
        where.contract = { customerId: Number(customerId) };
      }

      const [field, dir] = sort.split(":");
      const orderBy = [{ [field]: dir }];

      const [items, total] = await app.prisma.$transaction([
        app.prisma.installment.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            contract: {
              select: {
                id: true,
                status: true,
                customerId: true,
                customer: { select: { id: true, name: true, phone: true } }
              }
            }
          }
        }),
        app.prisma.installment.count({ where })
      ]);

      const filtered = overdueOnly ? items.filter((i) => i.dueDate < new Date() && i.paidCents < i.amountCents) : items;

      return {
        page,
        pageSize,
        total,
        count: filtered.length,
        items: filtered
      };
    }
  );

  // ---------- GET /installments/:id ----------
  app.get(
    "/:id",
    {
      ...canRead,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
      }
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      const inst = await app.prisma.installment.findUnique({
        where: { id },
        include: {
          contract: {
            select: { id: true, status: true, customerId: true, customer: { select: { id: true, name: true, phone: true } } }
          },
          payments: { orderBy: { paidAt: "desc" } }
        }
      });
      if (!inst) return reply.error(404, "Installment not found");
      return inst;
    }
  );

  // ---------- GET /installments/:id/payments ----------
  app.get(
    "/:id/payments",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
      }
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      const inst = await app.prisma.installment.findUnique({ where: { id } });
      if (!inst) return reply.error(404, "Installment not found");

      const payments = await app.prisma.payment.findMany({
        where: { installmentId: id },
        orderBy: { paidAt: "desc" }
      });
      return { installmentId: id, payments };
    }
  );

  // ---------- PATCH /installments/:id ----------
  app.patch(
    "/:id",
    {
      ...canCreatePay,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            dueDate: { type: "string", format: "date-time", nullable: true },
            amountCents: { type: "integer", minimum: 0, nullable: true },
            status: { type: "string", enum: Object.values(InstallmentStatus), nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      const { dueDate, amountCents, status } = req.body || {};

      const inst = await app.prisma.installment.findUnique({ where: { id } });
      if (!inst) return reply.error(404, "Installment not found");

      const data = {};
      if (dueDate) data.dueDate = new Date(dueDate);
      if (Number.isFinite(amountCents)) {
        if (amountCents < inst.paidCents) {
          return reply.error(400, "amountCents cannot be less than paidCents");
        }
        data.amountCents = amountCents;
      }
      if (status) data.status = status;

      const updated = await app.prisma.installment.update({ where: { id }, data });

      // إذا ما حدّدنا status يدوي، نعيد حسابه تلقائياً
      if (!status) {
        const nextStatus = await recalcInstallmentStatus(updated);
        if (nextStatus !== updated.status) {
          await app.prisma.installment.update({ where: { id }, data: { status: nextStatus } });
          updated.status = nextStatus;
        }
      }

      // عدّل حالة العقد
      const contract = await app.prisma.installment.findUnique({ where: { id } }).contract();
      await recalcContractStatus(app.prisma, contract.id);

      return updated;
    }
  );

  // ---------- POST /installments/:id/pay ----------
  app.post(
    "/:id/pay",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        body: {
          type: "object",
          required: ["amountCents"],
          properties: {
            amountCents: { type: "integer", minimum: 1 },
            paidAt: { type: "string", format: "date-time", nullable: true }
          },
          additionalProperties: false
        }
      }
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      const { amountCents, paidAt } = req.body;

      const now = paidAt ? new Date(paidAt) : new Date();

      return app.prisma.$transaction(async (tx) => {
        const inst = await tx.installment.findUnique({ where: { id } });
        if (!inst) {
          return reply.error(404, "Installment not found");
        }

        const remaining = Math.max(inst.amountCents - inst.paidCents, 0);
        if (remaining === 0) {
          // أصلاً مدفوع بالكامل
          return {
            installmentId: id,
            appliedCents: 0,
            remaining,
            message: "Installment already fully paid"
          };
        }

        const apply = Math.min(amountCents, remaining);

        await tx.payment.create({
          data: { installmentId: id, amountCents: apply, paidAt: now }
        });

        const updated = await tx.installment.update({
          where: { id },
          data: { paidCents: { increment: apply } }
        });

        // أعِد حساب حالة القسط
        const nextStatus = updated.paidCents + apply >= updated.amountCents ? InstallmentStatus.PAID : updated.dueDate < new Date() ? InstallmentStatus.LATE : InstallmentStatus.PENDING;

        let instAfter = updated;
        if (nextStatus !== updated.status) {
          instAfter = await tx.installment.update({ where: { id }, data: { status: nextStatus } });
        }

        // عدّل حالة العقد
        const contract = await tx.installment.findUnique({ where: { id } }).contract();
        const contractStatus = await recalcContractStatus(tx, contract.id);

        return {
          installment: instAfter,
          appliedCents: apply,
          leftoverCents: amountCents - apply, // لو أرسل مبلغ أكبر، نرجّع الباقي بالمخرجات فقط (ما نخزّنه)
          contractStatus
        };
      });
    }
  );

  // ---------- POST /contracts/:id/recalc ----------
  // مفيدة بعد تغييرات كبيرة
  app.post(
    "/contracts/:id/recalc",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
      }
    },
    async (req, reply) => {
      const contractId = Number(req.params.id);
      const contract = await app.prisma.contract.findUnique({ where: { id: contractId } });
      if (!contract) return reply.error(404, "Contract not found");

      await app.prisma.$transaction(async (tx) => {
        const insts = await tx.installment.findMany({ where: { contractId } });
        for (const inst of insts) {
          const next = await recalcInstallmentStatus(inst);
          if (next !== inst.status) {
            await tx.installment.update({ where: { id: inst.id }, data: { status: next } });
          }
        }
        await recalcContractStatus(tx, contractId);
      });

      const fresh = await app.prisma.contract.findUnique({
        where: { id: contractId },
        include: { installments: { orderBy: { seq: "asc" } } }
      });
      return fresh;
    }
  );
}
