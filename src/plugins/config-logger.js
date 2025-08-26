import "dotenv/config";
import fp from "fastify-plugin";
import { object, string, number } from "zod";
import winston from "winston";
import { format } from "date-fns-tz";

const ConfigSchema = object({
  NODE_ENV: string().nonempty(),
  TZ: string().nonempty(),
  PORT: number(),
  DATABASE_URL: string().url().nonempty(),
  JWT_SECRET: string().nonempty(),
  JWT_ACCESS_TOKEN_EXPIRES_IN: string().nonempty(),
  JWT_REFRESH_TOKEN_EXPIRES_IN: string().nonempty()
});

const envVariables = {
  NODE_ENV: process.env.NODE_ENV,
  TZ: process.env.TZ ?? "Asia/Baghdad",
  PORT: process.env.PORT ? Number(process.env.PORT) : 3003,
  SERVER_DOMAIN: process.env.SERVER_DOMAIN ?? "",
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? "",
  JWT_ACCESS_TOKEN_EXPIRES_IN: process.env.JWT_ACCESS_TOKEN_EXPIRES_IN ?? "",
  JWT_REFRESH_TOKEN_EXPIRES_IN: process.env.JWT_REFRESH_TOKEN_EXPIRES_IN ?? ""
};

let Config;
try {
  Config = ConfigSchema.parse(envVariables);
  console.log("Environment variables loaded successfully.");
} catch (error) {
  if (error.errors) {
    console.error("Invalid environment variables:", error.errors);
  } else {
    console.error("Invalid environment variables:", error);
  }
  process.exit(1);
}

const logger = winston.createLogger({
  level: "info",
  defaultMeta: { serviceName: "fastify-api-starter" },
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => format(new Date(), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: Config.TZ })
    }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      level: "info",
      silent: Config.NODE_ENV === "test"
    })
  ]
});

export default fp(async function (fastify) {
  fastify.decorate("config", Config);
  fastify.decorate("logger", logger);
});
