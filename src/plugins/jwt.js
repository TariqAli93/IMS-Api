import fp from 'fastify-plugin';
export default fp(async (app) => {
  await app.register(import('@fastify/jwt'), { secret: process.env.JWT_SECRET });
  app.decorate('verifyJwt', async (req, rep) => {
    try { await req.jwtVerify(); } catch { return rep.code(401).send({ message: 'Unauthorized' }); }
  });
});
