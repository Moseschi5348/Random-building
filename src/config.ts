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
  GRAPH_TENANT_ID: optionalEnvString.pipe(z.string().uuid().optional()),
  GRAPH_CLIENT_ID: optionalEnvString.pipe(z.string().uuid().optional()),
  GRAPH_CLIENT_SECRET: optionalEnvString.pipe(z.string().min(1).optional()),
  GRAPH_SENDER_EMAIL: optionalEnvString.pipe(
    z.string().email().refine(
      (email) => email.toLowerCase().endsWith("@nutm.edu.ng"),
      "GRAPH_SENDER_EMAIL must be a NUTM address.",
    ).optional(),
  ),
}).superRefine((data, context) => {
  const graphValues = [
    data.GRAPH_TENANT_ID,
    data.GRAPH_CLIENT_ID,
    data.GRAPH_CLIENT_SECRET,
    data.GRAPH_SENDER_EMAIL,
  ];
  if (graphValues.some(Boolean) && graphValues.some((value) => !value)) {
    context.addIssue({
      code: "custom",
      message: "Set all four GRAPH_* variables to enable verification email delivery.",
      path: ["GRAPH_TENANT_ID"],
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
  graph: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    senderEmail: string;
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

  const graph =
    parsed.data.GRAPH_TENANT_ID &&
    parsed.data.GRAPH_CLIENT_ID &&
    parsed.data.GRAPH_CLIENT_SECRET &&
    parsed.data.GRAPH_SENDER_EMAIL
      ? {
          tenantId: parsed.data.GRAPH_TENANT_ID,
          clientId: parsed.data.GRAPH_CLIENT_ID,
          clientSecret: parsed.data.GRAPH_CLIENT_SECRET,
          senderEmail: parsed.data.GRAPH_SENDER_EMAIL,
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
    graph,
  };
}
