// src/modules/customers/routes.js
export default async function routes(app) {
  const canRead = { preHandler: [app.verifyJwt, app.authorize("customers", "read")] };
  const canCreate = { preHandler: [app.verifyJwt, app.authorize("customers", "create")] };
  const canUpdate = { preHandler: [app.verifyJwt, app.authorize("customers", "update")] };
  const canDelete = { preHandler: [app.verifyJwt, app.authorize("customers", "delete")] };
  const schema = {
    tags: ["customers"]
  };
  // utils
  const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };

  // ---------- GET /customers ----------
  // ?page=1&pageSize=20&q=ali&sort=name:asc|createdAt:desc
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
            q: { type: "string", nullable: true },
            sort: { type: "string", enum: ["name:asc", "name:desc", "createdAt:asc", "createdAt:desc"], default: "createdAt:desc" }
          }
        }
      }
    },
    async (req) => {
      const page = toInt(req.query.page, 1);
      const pageSize = toInt(req.query.pageSize, 20);
      const { q, sort = "createdAt:desc" } = req.query;

      const where = q
        ? {
            OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q, mode: "insensitive" } }]
          }
        : {};

      const [field, dir] = sort.split(":");
      const orderBy = [{ [field]: dir }];

      const [items, total] = await app.prisma.$transaction([
        app.prisma.customer.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            _count: { select: { contracts: true, documents: true } }
          }
        }),
        app.prisma.customer.count({ where })
      ]);

      return {
        page,
        pageSize,
        total,
        items
      };
    }
  );

  // ---------- GET /customers/:id ----------
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
      const id = toInt(req.params.id);
      const customer = await app.prisma.customer.findUnique({
        where: { id },
        include: {
          _count: { select: { contracts: true, documents: true } }
        }
      });
      if (!customer) return reply.error(404, "Customer not found");
      return customer;
    }
  );

  // ---------- POST /customers ----------
  app.post(
    "/",
    {
      ...canCreate,
      schema: {
        ...schema,
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1 },
            phone: { type: "string", nullable: true }
          }
        }
      }
    },
    async (req) => {
      const { name, phone } = req.body;
      const customer = await app.prisma.customer.create({ data: { name, phone } });
      return customer;
    }
  );

  // ---------- PATCH /customers/:id ----------
  app.patch(
    "/:id",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, nullable: true },
            phone: { type: "string", nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      try {
        const updated = await app.prisma.customer.update({
          where: { id },
          data: req.body
        });
        return updated;
      } catch (e) {
        // لو id غير موجود
        return reply.error(404, "Customer not found");
      }
    }
  );

  // ---------- DELETE /customers/:id ----------
  // حماية: لا تحذف إذا عنده عقود أو مستندات
  app.delete(
    "/:id",
    {
      ...canDelete,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
      }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      const customer = await app.prisma.customer.findUnique({
        where: { id },
        include: { _count: { select: { contracts: true, documents: true } } }
      });
      if (!customer) return reply.error(404, "Customer not found");

      const hasRefs = customer._count.contracts > 0 || customer._count.documents > 0;
      if (hasRefs) {
        return reply.error(409, "Cannot delete customer with existing contracts/documents", { counts: customer._count });
      }

      await app.prisma.customer.delete({ where: { id } });
      return { ok: true };
    }
  );

  // ---------- GET /customers/:id/contracts ----------
  app.get(
    "/:id/contracts",
    {
      ...canRead,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["ACTIVE", "CLOSED", "DEFAULTED"], nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      const { status } = req.query;
      const customer = await app.prisma.customer.findUnique({ where: { id } });
      if (!customer) return reply.error(404, "Customer not found");

      const contracts = await app.prisma.contract.findMany({
        where: { customerId: id, ...(status ? { status } : {}) },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { installments: true, items: true } }
        }
      });
      return { customerId: id, contracts };
    }
  );

  // ---------- GET /customers/:id/documents ----------
  app.get(
    "/:id/documents",
    {
      ...canRead,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
      }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      const exists = await app.prisma.customer.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return reply.error(404, "Customer not found");

      const docs = await app.prisma.document.findMany({
        where: { customerId: id },
        orderBy: { uploadedAt: "desc" }
      });
      return { customerId: id, documents: docs };
    }
  );
}
