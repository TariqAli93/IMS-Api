export default async function statusRoutes(app, opts) {
  // GET /status -> health check
  app.get("/", async (req, reply) => {
    let dbOk = false;
    try {
      // Lightweight DB check; works across common SQL providers
      await app.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch (err) {
      app.log.warn({ err }, "Database health check failed");
    }

    const payload = {
      status: dbOk ? "ok" : "partial",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      db: { ok: dbOk }
    };

    return reply.code(dbOk ? 200 : 503).send(payload);
  });
}
