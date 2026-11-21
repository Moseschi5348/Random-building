import "dotenv/config";
import { z } from "zod";

const optionalEnvString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  OTP_HASH_SECRET: z.string().min(32),
  CLIENT_URL: z.string().url(),
  CORS_ORIGIN: z.string().min(1).refine(
    (value) => !value.split(",").some((origin) => origin.trim() === "*"),
    "CORS_ORIGIN cannot contain a wildcard.",
  ),
  ADMIN_EMAIL: z.string().email().optional(),
  GMAIL_USER: optionalEnvString.pipe(z.string().email().optional()),
  GMAIL_APP_PASSWORD: z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const password = value.replace(/\s/g, "");
      return password || undefined;
    },
    z.string().min(1).optional(),
  ),
}).superRefine((data, context) => {
  if (Boolean(data.GMAIL_USER) !== Boolean(data.GMAIL_APP_PASSWORD)) {
    context.addIssue({
      code: "custom",
      message: "Set both GMAIL_USER and GMAIL_APP_PASSWORD to enable verification email delivery.",
      path: ["GMAIL_USER"],
    });
  }
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  otpHashSecret: string;
  clientUrl: string;
  corsOrigins: string[];
  gmail: {
    user: string;
    appPassword: string;
  } | null;
};

export function getConfig(): AppConfig {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
  }

  const corsOrigins = parsed.data.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (corsOrigins.some((origin) => {
    try {
      new URL(origin);
      return false;
    } catch {
      return true;
    }
  })) {
    throw new Error("Invalid environment configuration: CORS_ORIGIN entries must be URLs.");
  }
  if (parsed.data.NODE_ENV === "production") {
    if (
      corsOrigins.some((origin) => new URL(origin).protocol !== "https:")
    ) {
      throw new Error("Invalid environment configuration: production CORS origins must use HTTPS.");
    }
    if (new URL(parsed.data.CLIENT_URL).protocol !== "https:") {
      throw new Error("Invalid environment configuration: production CLIENT_URL must use HTTPS.");
    }
    if (parsed.data.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
      throw new Error("Invalid environment configuration: production cannot use a Stripe test key.");
    }
  }

  const gmail =
    parsed.data.GMAIL_USER && parsed.data.GMAIL_APP_PASSWORD
      ? {
          user: parsed.data.GMAIL_USER,
          appPassword: parsed.data.GMAIL_APP_PASSWORD,
        }
      : null;

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    stripeSecretKey: parsed.data.STRIPE_SECRET_KEY,
    stripeWebhookSecret: parsed.data.STRIPE_WEBHOOK_SECRET,
    otpHashSecret: parsed.data.OTP_HASH_SECRET,
    clientUrl: parsed.data.CLIENT_URL,
    corsOrigins,
    gmail,
  };
}
