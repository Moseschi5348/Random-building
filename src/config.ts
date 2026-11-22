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
  DIRECT_URL: z.string().min(1),
  STRIPE_SECRET_KEY: optionalEnvString.pipe(z.string().startsWith("sk_").optional()),
  STRIPE_WEBHOOK_SECRET: optionalEnvString.pipe(z.string().startsWith("whsec_").optional()),
  CLIENT_URL: z.string().url(),
  CORS_ORIGIN: z.string().min(1).refine(
    (value) => !value.split(",").some((origin) => origin.trim() === "*"),
    "CORS_ORIGIN cannot contain a wildcard.",
  ),
  ADMIN_EMAIL: z.string().email().optional(),
  GOOGLE_CLIENT_ID: optionalEnvString.pipe(z.string().min(1).optional()),
  GOOGLE_CLIENT_SECRET: optionalEnvString.pipe(z.string().min(1).optional()),
  GOOGLE_CALLBACK_URL: optionalEnvString.pipe(z.string().url().optional()),
}).superRefine((data, context) => {
  const stripeValues = [data.STRIPE_SECRET_KEY, data.STRIPE_WEBHOOK_SECRET];
  if (stripeValues.some(Boolean) && stripeValues.some((value) => !value)) {
    context.addIssue({
      code: "custom",
      message: "Set both STRIPE_* variables to enable payments.",
      path: ["STRIPE_SECRET_KEY"],
    });
  }

  const googleValues = [
    data.GOOGLE_CLIENT_ID,
    data.GOOGLE_CLIENT_SECRET,
    data.GOOGLE_CALLBACK_URL,
  ];
  if (googleValues.some(Boolean) && googleValues.some((value) => !value)) {
    context.addIssue({
      code: "custom",
      message: "Set all three GOOGLE_* variables to enable Google sign-in.",
      path: ["GOOGLE_CLIENT_ID"],
    });
  }
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  directUrl: string;
  stripe: {
    secretKey: string;
    webhookSecret: string;
  } | null;
  clientUrl: string;
  corsOrigins: string[];
  google: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
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
  const google =
    parsed.data.GOOGLE_CLIENT_ID &&
    parsed.data.GOOGLE_CLIENT_SECRET &&
    parsed.data.GOOGLE_CALLBACK_URL
      ? {
          clientId: parsed.data.GOOGLE_CLIENT_ID,
          clientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
          callbackUrl: parsed.data.GOOGLE_CALLBACK_URL,
        }
      : null;
  const stripe =
    parsed.data.STRIPE_SECRET_KEY && parsed.data.STRIPE_WEBHOOK_SECRET
      ? {
          secretKey: parsed.data.STRIPE_SECRET_KEY,
          webhookSecret: parsed.data.STRIPE_WEBHOOK_SECRET,
        }
      : null;
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
    if (google && new URL(google.callbackUrl).protocol !== "https:") {
      throw new Error("Invalid environment configuration: production Google callback must use HTTPS.");
    }
    if (stripe && stripe.secretKey.startsWith("sk_test_")) {
      throw new Error("Invalid environment configuration: production cannot use a Stripe test key.");
    }
  }
  if (
    google &&
    new URL(google.callbackUrl).origin !== new URL(parsed.data.CLIENT_URL).origin
  ) {
    throw new Error("Invalid environment configuration: Google callback must use the CLIENT_URL origin.");
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    directUrl: parsed.data.DIRECT_URL,
    stripe,
    clientUrl: parsed.data.CLIENT_URL,
    corsOrigins,
    google,
  };
}
