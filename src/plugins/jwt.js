import fp from 'fastify-plugin';
export default fp(async (app) => {
  await app.register(import('@fastify/jwt'), {
    secret: process.env.JWT_SECRET,
    // Set default token expiry from env; fallback to 15 minutes
    sign: {
      expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRES_IN || '15m'
    }
    // Optionally, you can set verify options like issuer/audience here
  });
  app.decorate('verifyJwt', async (req, rep) => {
    try {
      await req.jwtVerify();
    } catch {
      return rep.code(401).send({ message: 'Unauthorized' });
    }
  });
});
