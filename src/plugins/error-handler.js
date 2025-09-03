import fp from "fastify-plugin";

function statusFromError(err) {
  if (typeof err.statusCode === "number") return err.statusCode;
  if (typeof err.status === "number") return err.status;
  return 500;
}

export default fp(async function errorHandler(app) {
  // Standard reply helper: reply.error(code, message, details?)
  app.decorateReply("error", function error(code, message, details = null) {
    this.code(code).send({ code, message, details });
  });

  // Unify framework/validation errors
  app.setErrorHandler((err, _req, reply) => {
    // Fastify validation error
    if (err?.validation) {
      return reply
        .code(400)
        .send({ code: 400, message: "Validation error", details: err.validation });
    }
    const code = statusFromError(err);
    const message = err?.message || "Internal Server Error";
    const details = process.env.NODE_ENV === "development" ? { stack: err.stack } : null;
    reply.code(code).send({ code, message, details });
  });
});

