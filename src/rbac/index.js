// plugins/rbac.js (ESM)
import fp from "fastify-plugin";

/**
 * نحفظ الصلاحيات كسلاسل "resource:action"
 * ندعم wildcards بالـ DB: resource="*" أو action="*"
 * مثال: { resource: 'product', action: 'read' } -> "product:read"
 */
const keyOf = (res, act) => `${res}:${act}`;

async function loadGrants(prisma) {
  const roles = await prisma.role.findMany({
    select: {
      name: true,
      perms: {
        select: {
          perm: { select: { resource: true, action: true } }
        }
      }
    }
  });

  // Map<string role, Set<string permKey>>
  const grants = new Map();
  for (const r of roles) {
    const set = grants.get(r.name) ?? new Set();
    for (const { perm } of r.perms) {
      set.add(keyOf(perm.resource, perm.action));
    }
    grants.set(r.name, set);
  }
  return grants;
}

function makeRbac({ grants, superRoles = ["ADMIN"] }) {
  function can(roles, resource, action) {
    if (!Array.isArray(roles) || roles.length === 0) return false;

    // bypass
    if (roles.some((r) => superRoles.includes(r))) return true;

    const exact = keyOf(resource, action);
    const resAny = keyOf(resource, "*");
    const actAny = keyOf("*", action);
    const anyAny = keyOf("*", "*");

    for (const role of roles) {
      const set = grants.get(role);
      if (!set) continue;
      if (set.has(exact) || set.has(resAny) || set.has(actAny) || set.has(anyAny)) {
        return true;
      }
    }
    return false;
  }

  return { can };
}

/**
 * خيارات:
 *  - prismaKey: اسم ديكوريت Prisma (افتراضياً 'prisma')
 *  - superRoles: أدوار تتجاوز كلشي (افتراضياً ['ADMIN'])
 *  - getUserRoles(req): كيف تجيب أدوار المستخدم (افتراضياً req.user.roles)
 */
export default fp(
  async function rbacPlugin(fastify, opts) {
    const { prismaKey = "prisma", superRoles = ["ADMIN"], getUserRoles = (req) => (Array.isArray(req.user?.roles) ? req.user.roles : []) } = opts ?? {};

    const prisma = fastify[prismaKey];
    if (!prisma) throw new Error(`rbac: fastify.${prismaKey} غير موجود`);

    let grants = await loadGrants(prisma);
    let rbac = makeRbac({ grants, superRoles });

    // يديكوريت
    fastify.decorate("rbac", {
      can: (roles, resource, action) => rbac.can(roles, resource, action)
    });

    // إعادة تحميل (بعد seeding مثلاً)
    fastify.decorate("reloadRBAC", async () => {
      grants = await loadGrants(prisma);
      rbac = makeRbac({ grants, superRoles });
      fastify.log.info("RBAC reloaded");
    });

    /**
     * preHandler بسيط:
     * app.authorize(resource, action)
     * أو app.authorize({ resource, action, allowRoles?, denyRoles? })
     */
    fastify.decorate("authorize", function authorize(arg1, arg2) {
      const opts = typeof arg1 === "string" ? { resource: arg1, action: arg2 } : arg1;

      const { resource, action, allowRoles = [], denyRoles = [] } = opts ?? {};
      if (!resource || !action) throw new Error("authorize: resource/action مطلوبين");

      return async function preHandler(req, rep) {
        const roles = getUserRoles(req);

        // deny أولاً
        if (roles.some((r) => denyRoles.includes(r))) {
          return rep.code(403).send({ message: "Forbidden" });
        }
        // allowRoles bypass
        if (roles.some((r) => allowRoles.includes(r))) return;

        const ok = fastify.rbac.can(roles, resource, action);
        if (!ok) return rep.code(403).send({ message: "Forbidden" });
      };
    });
  },
  { name: "rbac-plugin" }
);
