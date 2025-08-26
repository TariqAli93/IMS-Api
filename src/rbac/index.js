import AccessControl from 'accesscontrol';
export async function buildAccessControlFromDB(prisma) {
  const roles = await prisma.role.findMany({ include: { perms: { include: { perm: true } } } });
  const grants = {};
  for (const r of roles) {
    grants[r.name] = grants[r.name] || {};
    for (const rp of r.perms) {
      const res = rp.perm.resource;
      const act = rp.perm.action;
      const acAction = mapToACAction(act);
      grants[r.name][res] = grants[r.name][res] || { 'create:any': [], 'read:any': [], 'update:any': [], 'delete:any': [] };
      grants[r.name][res][acAction] = ['*'];
    }
  }
  return new AccessControl(grants);
}
function mapToACAction(a) {
  switch (a) {
    case 'create': return 'create:any';
    case 'read':   return 'read:any';
    case 'update': return 'update:any';
    case 'delete': return 'delete:any';
    default:       return 'read:any';
  }
}
export function authorize(ac, resource, action) {
  const acAction = mapToACAction(action);
  return async (req, rep) => {
    const roles = (req.user?.roles) || [];
    const granted = roles.some(role => {
      try { return ac.can(role)[acAction.split(':')[0] + 'Any'](resource).granted; }
      catch { return false; }
    });
    if (!granted) return rep.code(403).send({ message: 'Forbidden' });
  };
}
