import fp from 'fastify-plugin';
export default fp(async (app) => {
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 10 * 1024 * 1024 }
  });
});
