import fp from "fastify-plugin";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export default fp(async (app) => {
  await app.register(import("@fastify/static"), {
    root: join(__dirname, "../../uploads"),
    prefix: "/uploads/"
  });
});
