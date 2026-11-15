import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile();

const optionalEnvString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const optionalEnvEmail = z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional());
const optionalEnvPort = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.coerce.number().int().min(1).max(65535).optional()
);
const optionalEncryptionKey = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().regex(/^[0-9a-f]{64}$/i, "WEBHOOK_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters").optional()
);
const platformAdminEmails = z.string().default("")
  .transform((value) => [...new Set(value.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean))])
  .pipe(z.array(z.string().email()));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/nanobaas.sqlite"),
  STORAGE_PATH: z.string().min(1).default("./data/storage"),
  MAX_FILE_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(5 * 1024 * 1024),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: z.string().default("false"),
  SMTP_HOST: optionalEnvString,
  SMTP_PORT: optionalEnvPort,
  SMTP_USER: optionalEnvString,
  SMTP_PASSWORD: optionalEnvString,
  SMTP_FROM: optionalEnvEmail,
  WEBHOOK_ENCRYPTION_KEY: optionalEncryptionKey,
  PLATFORM_ADMIN_EMAILS: platformAdminEmails
}).superRefine((config, context) => {
  const mailSettings = [config.SMTP_HOST, config.SMTP_PORT, config.SMTP_USER, config.SMTP_PASSWORD, config.SMTP_FROM];
  if (mailSettings.some((value) => value !== undefined) && (!config.SMTP_HOST || !config.SMTP_FROM)) {
    context.addIssue({ code: "custom", message: "SMTP_HOST and SMTP_FROM are required when SMTP is configured" });
  }
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD)) {
    context.addIssue({ code: "custom", message: "SMTP_USER and SMTP_PASSWORD must be configured together" });
  }
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  const config = parsed.data;
  return {
    ...config,
    corsOrigins: config.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    platformAdminEmails: config.PLATFORM_ADMIN_EMAILS,
    trustProxy: config.TRUST_PROXY === "true"
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
