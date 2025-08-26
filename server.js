import app from "./app/app.js";
const PORT = app.config.PORT;

if (app.config.NODE_ENV === "development") {
  app.logger.info(`[✨] Environment: ${app.config.NODE_ENV} 🛠️`);
} else if (app.config.NODE_ENV === "production") {
  app.logger.info(`[✨] Environment: ${app.config.NODE_ENV} 🌐`);
}
app.logger.info(`Server is running on port ${PORT}`);
app.logger.info(`Server is running in ${app.config.NODE_ENV} mode`);
app.logger.info(`Swagger documentation is available at http://localhost:${PORT}/docs`);

await app.listen({ port: PORT, host: "0.0.0.0" });
