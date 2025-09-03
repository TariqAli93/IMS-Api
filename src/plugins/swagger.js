import fp from "fastify-plugin";
import fs from "fs";
export default fp(async (app) => {
  const routePath = fs.readdirSync("./src/modules").filter((file) => file);
  await app.register(import("@fastify/swagger"), {
    openapi: {
      info: {
        title: "Tasdeed API",
        description: "API with JWT authentication",
        version: "1.0.0"
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT"
          }
        },
        schemas: {
          Error: {
            type: "object",
            properties: {
              code: { type: "integer", example: 400 },
              message: { type: "string", example: "Validation error" },
              details: { type: "object", nullable: true }
            }
          },
          AuthTokens: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
              refreshToken: { type: "string" }
            }
          }
        }
      },
      security: [
        { bearerAuth: [] } // 👈 global: كل الراوتات محمية
      ],
      tags: routePath.map((file) => ({
        name: file,
        description: `API endpoints for ${file} module`
      }))
    }
  });
  await app.register(import("@fastify/swagger-ui"), {
    routePrefix: "/docs",
    staticCSP: true,
    transformStaticCSP: (header) => header,

    // تقدر تغيّر هذي حسب رغبتك
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
      displayRequestDuration: true,
      tagsSorter: "alpha", // يرتّب مجموعات التاغات أبجدياً
      operationsSorter: "alpha" // يرتّب العمليات داخل كل تاغ
    }
  });
});
