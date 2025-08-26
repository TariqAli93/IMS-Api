import fp from "fastify-plugin";
import fastifyBcrypt from "fastify-bcrypt";

export default fp(async (app) => {
  app.register(fastifyBcrypt, {
    saltWorkFactor: 10
  });
});
