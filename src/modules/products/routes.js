// src/modules/products/routes.js
export default async function routes(app) {
  const canRead = { preHandler: [app.verifyJwt, app.authorize("products", "read")] };
  const canCreate = { preHandler: [app.verifyJwt, app.authorize("products", "create")] };
  const canUpdate = { preHandler: [app.verifyJwt, app.authorize("products", "update")] };
  const canDelete = { preHandler: [app.verifyJwt, app.authorize("products", "delete")] };
  const schema = {
    tags: ["products"]
  };

  const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };

  // ---------- GET /products ----------
  // ?page=1&pageSize=20&q=laptop&sort=createdAt:desc&lowStock=true
  app.get(
    "/products",
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
            sort: { type: "string", enum: ["name:asc", "name:desc", "createdAt:asc", "createdAt:desc", "stock:asc", "stock:desc"], default: "createdAt:desc" },
            lowStock: { type: "boolean", nullable: true }
          }
        }
      }
    },
    async (req) => {
      const page = toInt(req.query.page, 1);
      const pageSize = toInt(req.query.pageSize, 20);
      const { q, sort = "createdAt:desc", lowStock } = req.query;

      const where = {};
      if (q) where.name = { contains: q, mode: "insensitive" };
      if (lowStock) {
        where.stock = { lte: app.prisma.product.fields.stockThreshold }; // غير مدعومة مباشرة، فنفلتر لاحقًا
      }

      const [field, dir] = sort.split(":");
      const orderBy = [{ [field]: dir }];

      const [items, total] = await app.prisma.$transaction([
        app.prisma.product.findMany({
          where: q ? where : {}, // نخلي فقط شرط الاسم بالـ query
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize
        }),
        app.prisma.product.count({ where: q ? where : {} })
      ]);

      const filtered = lowStock ? items.filter((p) => p.stock <= p.stockThreshold) : items;

      return {
        page,
        pageSize,
        total,
        count: filtered.length,
        items: filtered
      };
    }
  );

  // ---------- GET /products/:id ----------
  app.get(
    "/products/:id",
    {
      ...canRead,
      schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      const product = await app.prisma.product.findUnique({ where: { id } });
      if (!product) return reply.error(404, "Product not found");
      return product;
    }
  );

  // ---------- POST /products ----------
  app.post(
    "/products",
    {
      ...canCreate,
      schema: {
        ...schema,
        body: {
          type: "object",
          required: ["name", "priceCents"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1 },
            priceCents: { type: "integer", minimum: 0 },
            stock: { type: "integer", minimum: 0, default: 0 },
            stockThreshold: { type: "integer", minimum: 0, default: 5 }
          }
        }
      }
    },
    async (req) => {
      const { name, priceCents, stock = 0, stockThreshold = 5 } = req.body;
      return app.prisma.product.create({ data: { name, priceCents, stock, stockThreshold } });
    }
  );

  // ---------- PATCH /products/:id ----------
  app.patch(
    "/products/:id",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", nullable: true },
            priceCents: { type: "integer", minimum: 0, nullable: true },
            stock: { type: "integer", minimum: 0, nullable: true },
            stockThreshold: { type: "integer", minimum: 0, nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      try {
        return await app.prisma.product.update({ where: { id }, data: req.body });
      } catch (e) {
        return reply.error(404, "Product not found");
      }
    }
  );

  // ---------- DELETE /products/:id ----------
  // حماية: لا تحذف إذا مستخدم في عقود
  app.delete(
    "/products/:id",
    {
      ...canDelete,
      schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      const product = await app.prisma.product.findUnique({
        where: { id },
        include: { _count: { select: { items: true } } }
      });
      if (!product) return reply.error(404, "Product not found");
      if (product._count.items > 0) {
        return reply.error(409, "Cannot delete product linked to contracts");
      }
      await app.prisma.product.delete({ where: { id } });
      return { ok: true };
    }
  );
}
