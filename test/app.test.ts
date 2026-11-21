import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import type { Server } from "node:http";
import { createApp } from "../src/app";
import type { AppConfig } from "../src/config";

const stripe = new Stripe("sk_test_dis_backend");
const config: AppConfig = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "postgresql://test:test@localhost:5432/test",
  stripeSecretKey: "sk_test_dis_backend",
  stripeWebhookSecret: "whsec_dis_backend_test_secret",
  otpHashSecret: "test-only-otp-secret-with-more-than-32-characters",
  clientUrl: "http://localhost:5173",
  corsOrigins: ["http://localhost:5173"],
  graph: null,
};
const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

describe("API security and health", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp(prisma, stripe, config).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to a TCP port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await prisma.$disconnect();
  });

  it("serves a healthy response with security headers", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the landing, dashboard, sign-in pages, and frontend assets", async () => {
    const [landing, dashboard, login, register, authScript, font] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/home.html`),
      fetch(`${baseUrl}/login.html`),
      fetch(`${baseUrl}/register.html`),
      fetch(`${baseUrl}/auth.js`),
      fetch(`${baseUrl}/assets/fonts/Roboto-Regular.ttf`),
    ]);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Find a club");
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("data-protected-page");
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('id="login-form"');
    expect(register.status).toBe(200);
    expect(await register.text()).toContain('id="verify-email-form"');
    expect(authScript.status).toBe(200);
    expect(await authScript.text()).toContain("/api/auth/session");
    expect(font.status).toBe(200);
  });

  it("serves the landing, dashboard, sign-in pages, and frontend assets", async () => {
    const [landing, dashboard, login, register, authScript, font] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/home.html`),
      fetch(`${baseUrl}/login.html`),
      fetch(`${baseUrl}/register.html`),
      fetch(`${baseUrl}/auth.js`),
      fetch(`${baseUrl}/assets/fonts/Roboto-Regular.ttf`),
    ]);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Find a club");
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("data-protected-page");
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('id="login-form"');
    expect(register.status).toBe(200);
    expect(await register.text()).toContain('id="verify-email-form"');
    expect(authScript.status).toBe(200);
    expect(await authScript.text()).toContain("/api/auth/session");
    expect(font.status).toBe(200);
  });

  it("rejects unapproved CORS origins", async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { origin: "https://malicious.example" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects protected routes without a session cookie or bearer token", async () => {
    const [profile, session, notices] = await Promise.all([
      fetch(`${baseUrl}/api/me`),
      fetch(`${baseUrl}/api/auth/session`),
      fetch(`${baseUrl}/api/student-life/notices`),
    ]);
    expect(profile.status).toBe(401);
    expect(session.status).toBe(401);
    expect(notices.status).toBe(401);
  });

  it("allows the CSRF header during CORS preflight from the configured frontend", async () => {
    const response = await fetch(`${baseUrl}/api/me`, {
      method: "OPTIONS",
      headers: {
        origin: config.corsOrigins[0],
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-csrf-token",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase())
      .toContain("x-csrf-token");
  });

  it("allows the CSRF header during CORS preflight from the configured frontend", async () => {
    const response = await fetch(`${baseUrl}/api/me`, {
      method: "OPTIONS",
      headers: {
        origin: config.corsOrigins[0],
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-csrf-token",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase())
      .toContain("x-csrf-token");
  });

  it("rejects account registration outside the NUTM email domain", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Student",
        email: "student@example.com",
        password: "a-very-long-password",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("reports missing Microsoft Graph email configuration", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Student",
        email: "student@nutm.edu.ng",
        password: "a-very-long-password",
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Verification email delivery has not been configured." });
  });

  it("rejects unsigned Stripe webhook requests", async () => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=0,v1=invalid",
      },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });
});
