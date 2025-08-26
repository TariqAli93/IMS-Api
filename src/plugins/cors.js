import fp from 'fastify-plugin';
export default fp(async (app) => {
  await app.register(import('@fastify/cors'), { origin: true, credentials: true });
});
