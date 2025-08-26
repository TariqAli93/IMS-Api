// routes/admin-rbac.js (ESM Fastify plugin)
// Admin endpoints to manage Roles, Permissions, and Grants used by the RBAC UI.
// Secured: require JWT + super permission ("*:*" or ADMIN via superRoles).

/**
 * Expected Prisma models (based on your schema):
 * model Role { id Int @id @default(autoincrement()) name RoleName @unique perms RolePermission[] }
 * model Permission { id Int @id @default(autoincrement()) resource String action String roles RolePermission[]
 *   @@unique([resource, action])
 * }
 * model RolePermission { roleId Int permId Int role Role @relation(fields: [roleId], references: [id]) perm Permission @relation(fields: [permId], references: [id])
 *   @@id([roleId, permId]) // or @@unique([roleId, permId])
 * }
 */

export default async function adminRbacRoutes(app) {
  const prisma = app.prisma; // change if your prismaKey differs
  if (!prisma) throw new Error("admin-rbac: fastify.prisma missing");

  const adminGuard = [app.verifyJwt, app.authorize("*", "*")];

  // ---- helpers ----
  async function getRoleByName(name) {
    return prisma.role.findUnique({ where: { name } });
  }

  async function getOrCreatePermission(resource, action) {
    return prisma.permission.upsert({
      where: { resource_action: { resource, action } },
      update: {},
      create: { resource, action }
    });
  }

  // ---- routes ----

  // List roles
  app.get("/admin/rbac/roles", { preHandler: adminGuard, schema: { tags: ["admin"] } }, async () => {
    return prisma.role.findMany({ select: { name: true }, orderBy: { name: "asc" } });
  });

  // List permissions
  app.get("/admin/rbac/perms", { preHandler: adminGuard, schema: { tags: ["admin"] } }, async () => {
    return prisma.permission.findMany({ select: { id: true, resource: true, action: true }, orderBy: [{ resource: "asc" }, { action: "asc" }] });
  });

  // Map of grants { [roleName]: [{resource, action}] }
  app.get("/admin/rbac/grants", { preHandler: adminGuard, schema: { tags: ["admin"] } }, async () => {
    const roles = await prisma.role.findMany({
      select: {
        name: true,
        perms: { select: { perm: { select: { resource: true, action: true } } } }
      },
      orderBy: { name: "asc" }
    });

    const out = {};
    for (const r of roles) {
      out[r.name] = r.perms.map((p) => p.perm);
    }
    return out;
  });

  // Create role
  app.post(
    "/admin/rbac/roles",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["admin"],
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } }
        }
      }
    },
    async (req, rep) => {
      const name = String(req.body.name).trim().toUpperCase();
      const role = await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
      return role;
    }
  );

  // Create permission (or get existing)
  app.post(
    "/admin/rbac/perm",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["admin"],
        body: {
          type: "object",
          required: ["resource", "action"],
          properties: { resource: { type: "string", minLength: 1 }, action: { type: "string", minLength: 1 } }
        }
      }
    },
    async (req) => {
      const { resource, action } = req.body;
      const perm = await getOrCreatePermission(resource, action);
      return perm;
    }
  );

  // Assign grant to role
  app.post(
    "/admin/rbac/assign",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["admin"],
        body: {
          type: "object",
          required: ["role", "resource", "action"],
          properties: {
            role: { type: "string", minLength: 1 },
            resource: { type: "string", minLength: 1 },
            action: { type: "string", minLength: 1 }
          }
        }
      }
    },
    async (req, rep) => {
      const { role: roleName, resource, action } = req.body;
      const role = await getRoleByName(roleName);
      if (!role) return rep.code(400).send({ message: "Role not found" });
      const perm = await getOrCreatePermission(resource, action);

      await prisma.rolePermission.upsert({
        where: { roleId_permId: { roleId: role.id, permId: perm.id } },
        update: {},
        create: { roleId: role.id, permId: perm.id }
      });

      return { ok: true };
    }
  );

  // Remove grant from role
  app.put(
    "/admin/rbac/assign",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["admin"],
        body: {
          type: "object",
          required: ["role", "resource", "action"],
          properties: {
            role: { type: "string", minLength: 1 },
            resource: { type: "string", minLength: 1 },
            action: { type: "string", minLength: 1 }
          }
        }
      }
    },
    async (req, rep) => {
      const { role: roleName, resource, action } = req.body;
      const role = await getRoleByName(roleName);
      if (!role) return rep.code(400).send({ message: "Role not found" });

      const perm = await prisma.permission.findUnique({ where: { resource_action: { resource, action } } });
      if (!perm) return { ok: true }; // nothing to delete

      await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permId: perm.id } });
      return { ok: true };
    }
  );

  // Reload RBAC cache in-memory (from your plugin)
  app.get("/admin/rbac/reload", { preHandler: adminGuard, schema: { tags: ["admin"] } }, async (req, rep) => {
    if (typeof app.reloadRBAC === "function") {
      await app.reloadRBAC();
      return { ok: true };
    } else {
      return rep.code(500).send({ message: "reloadRBAC function not available" });
    }
  });
}

// Usage in server.js
// import adminRbacRoutes from './routes/admin-rbac.js'
// await app.register(adminRbacRoutes)
