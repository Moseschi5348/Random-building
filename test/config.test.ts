import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("environment configuration", () => {
  it("allows Stripe to be omitted for Google sign-in projects", () => {
    const env = {
      NODE_ENV: "test",
      PORT: "3000",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      DIRECT_URL: "postgresql://test:test@localhost:5432/test",
      CLIENT_URL: "http://localhost:3000",
      CORS_ORIGIN: "http://localhost:3000",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_CALLBACK_URL: "",
      ADMIN_EMAIL: "admin@example.com",
    };
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }

    expect(getConfig().stripe).toBeNull();
    expect(getConfig().adminEmail).toBe("admin@example.com");
  });
});
