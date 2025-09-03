export default async function routes(app) {
  const canRead = { preHandler: [app.verifyJwt, app.authorize("users", "read")] };
  const canCreate = { preHandler: [app.verifyJwt, app.authorize("users", "create")] };
  const canUpdate = { preHandler: [app.verifyJwt, app.authorize("users", "update")] };
  const canDelete = { preHandler: [app.verifyJwt, app.authorize("users", "delete")] };
  const schema = { tags: ["users"] };

  const ROLE_NAMES = ["ADMIN", "MANAGER", "STAFF", "OWNER"];

  const toUserDto = (u) => ({
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    roles: (u.roles || []).map((ur) => ur.role?.name).filter(Boolean)
  });

  // ---------- GET /users/me ----------
  app.get("/me", { ...canRead, schema: { ...schema } }, async (req) => ({ user: req.user }));

  // ---------- GET /users ----------
  app.get("/", { ...canRead, schema: { ...schema } }, async () => {
    const users = await app.prisma.user.findMany({
      orderBy: { id: "asc" },
      include: { roles: { include: { role: { select: { name: true } } } } }
    });
    return users.map(toUserDto);
  });

  // ---------- POST /users ----------
  app.post(
    "/",
    {
      ...canCreate,
      schema: {
        ...schema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["username", "password"],
          properties: {
            username: { type: "string", minLength: 1 },
            password: { type: "string", minLength: 6 },
            roles: { type: "array", items: { type: "string", enum: ROLE_NAMES }, nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const { username, password, roles = [] } = req.body;
      try {
        const hashed = await app.bcrypt.hash(password);
        const created = await app.prisma.user.create({
          data: {
            username,
            password: hashed,
            ...(roles.length ? { roles: { create: roles.map((name) => ({ role: { connect: { name } } })) } } : {})
          },
          include: { roles: { include: { role: { select: { name: true } } } } }
        });
        return toUserDto(created);
      } catch (e) {
        return reply.error(409, "Username already exists");
      }
    }
  );

  // ---------- DELETE /:id ----------
  app.delete(
    "/:id",
    {
      ...canDelete,
      schema: { ...schema, params: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } }
    },
    async (req, _reply) => {
      const id = Number(req.params.id);
      await app.prisma.$transaction([app.prisma.userRole.deleteMany({ where: { userId: id } }), app.prisma.user.delete({ where: { id } })]).catch(() => null);
      return { message: "User deleted" };
    }
  );

  // ---------- PATCH /:id ----------
  app.patch(
    "/:id",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 1, nullable: true },
            password: { type: "string", minLength: 6, nullable: true },
            roles: { type: "array", items: { type: "string", enum: ROLE_NAMES }, nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      const { username, password, roles } = req.body || {};

      try {
        const data = {};
        if (username) data.username = username;
        if (password) data.password = await app.bcrypt.hash(password);

        const result = await app.prisma.$transaction(async (tx) => {
          if (Object.keys(data).length) {
            await tx.user.update({ where: { id }, data });
          }
          if (Array.isArray(roles)) {
            await tx.userRole.deleteMany({ where: { userId: id } });
            if (roles.length) {
              await tx.user.update({
                where: { id },
                data: { roles: { create: roles.map((name) => ({ role: { connect: { name } } })) } }
              });
            }
          }
          return tx.user.findUnique({ where: { id }, include: { roles: { include: { role: { select: { name: true } } } } } });
        });

        if (!result) return reply.error(404, "User not found");
        return toUserDto(result);
      } catch (e) {
        return reply.error(400, "Failed to update user");
      }
    }
  );

  // ---------- POST /:id/roles (assign) ----------
  app.post(
    "/:id/roles",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["roles"],
          properties: {
            roles: { type: "array", minItems: 1, items: { type: "string", enum: ROLE_NAMES } }
          }
        }
      }
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      const { roles } = req.body;

      // ensure user exists
      const exists = await app.prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return reply.error(404, "User not found");

      const result = await app.prisma.$transaction(async (tx) => {
        // resolve role ids by names
        const dbRoles = await tx.role.findMany({ where: { name: { in: roles } }, select: { id: true } });
        if (dbRoles.length === 0) return null;

        await tx.userRole.createMany({
          data: dbRoles.map((r) => ({ userId: id, roleId: r.id })),
          skipDuplicates: true
        });

        return tx.user.findUnique({ where: { id }, include: { roles: { include: { role: { select: { name: true } } } } } });
      });

      if (!result) return reply.error(400, "Invalid roles");
      return toUserDto(result);
    }
  );

  // ---------- DELETE /:id/roles (remove) ----------
  app.delete(
    "/:id/roles",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["roles"],
          properties: {
            roles: { type: "array", minItems: 1, items: { type: "string", enum: ROLE_NAMES } }
          }
        }
      }
    },
    async (req, reply) => {
      const id = Number(req.params.id);
      const { roles } = req.body;

      // ensure user exists
      const exists = await app.prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return reply.error(404, "User not found");

      await app.prisma.userRole.deleteMany({ where: { userId: id, role: { name: { in: roles } } } });
      const updated = await app.prisma.user.findUnique({ where: { id }, include: { roles: { include: { role: { select: { name: true } } } } } });
      return toUserDto(updated);
    }
  );

  // ---------- GET /:id ----------
  app.get("/:id", { ...canRead, schema: { ...schema, params: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } }, async (req, reply) => {
    const id = Number(req.params.id);
    const user = await app.prisma.user.findUnique({
      where: { id },
      include: { roles: { include: { role: { select: { name: true } } } } }
    });
    if (!user) return reply.error(404, "User not found");
    return toUserDto(user);
  });
}
