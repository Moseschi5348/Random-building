import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("15m"),
  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  CLIENT_URL: z.string().url(),
  CORS_ORIGIN: z.string().min(1),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  clientUrl: string;
  corsOrigins: string[];
};

export function getConfig(): AppConfig {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    jwtSecret: parsed.data.JWT_SECRET,
    jwtExpiresIn: parsed.data.JWT_EXPIRES_IN,
    stripeSecretKey: parsed.data.STRIPE_SECRET_KEY,
    stripeWebhookSecret: parsed.data.STRIPE_WEBHOOK_SECRET,
    clientUrl: parsed.data.CLIENT_URL,
    corsOrigins: parsed.data.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
  };
}
