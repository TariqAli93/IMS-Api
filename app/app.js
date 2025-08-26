import Fastify from "fastify";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// plugins
import prismaPlugin from "../src/core/prisma.js";
import jwt from "../src/plugins/jwt.js";
import cors from "../src/plugins/cors.js";
import helmet from "../src/plugins/helmet.js";
import rateLimit from "../src/plugins/rate-limit.js";
import swagger from "../src/plugins/swagger.js";
import multipart from "../src/plugins/multipart.js";
import serveStatic from "../src/plugins/static.js";
import bcrypt from "../src/plugins/bcrypt.js";
import configLogger from "../src/plugins/config-logger.js";
import rbacPlugin from "../src/rbac/index.js";
import adminRbacRoutes from "../src/rbac/admin-rbac.js";

import { autoloadRoutes } from "../src/utils/autoload.js";

const app = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: { colorize: true }
    },
    level: "info"
  }
});

await app.register(prismaPlugin);
await app.register(cors);
await app.register(helmet);
await app.register(rateLimit);
await app.register(swagger, {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: false
  }
});
await app.register(multipart);
await app.register(jwt);
await app.register(serveStatic);
await app.register(bcrypt);
await app.register(configLogger);
await app.register(import("../src/plugins/scheduler.js"), { enabled: true });

await app.register(rbacPlugin, {
  superRoles: ["ADMIN"],
  getUserRoles: (req) => (Array.isArray(req.user?.roles) ? req.user.roles : [])
});

await app.register(adminRbacRoutes);

// Auto routes
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
await autoloadRoutes(app, join(__dirname, "../src/modules"));

export default app;
