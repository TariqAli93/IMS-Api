import fp from 'fastify-plugin';
export default fp(async (app) => {
  await app.register(import('@fastify/rate-limit'), {
    max: 200,
    timeWindow: '1 minute'
  });
});
