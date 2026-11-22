import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import type { Server } from "node:http";
import { createApp } from "../src/app-factory";
import type { AppConfig } from "../src/config";

const stripe = new Stripe("sk_test_dis_backend");
const config: AppConfig = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "postgresql://test:test@localhost:5432/test",
  directUrl: "postgresql://test:test@localhost:5432/test",
  stripe: {
    secretKey: "sk_test_dis_backend",
    webhookSecret: "whsec_dis_backend_test_secret",
  },
  clientUrl: "http://localhost:5173",
  corsOrigins: ["http://localhost:5173"],
  google: null,
};
const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

describe("API security and health", () => {
  let server: Server;
  let googleServer: Server;
  let baseUrl: string;
  let googleBaseUrl: string;

  beforeAll(async () => {
    server = createApp(prisma, stripe, config).listen(0, "127.0.0.1");
    googleServer = createApp(prisma, null, {
      ...config,
      stripe: null,
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        callbackUrl: "http://localhost:5173/api/auth/google/callback",
      },
    }).listen(0, "127.0.0.1");
    await Promise.all([
      new Promise<void>((resolve) => server.once("listening", resolve)),
      new Promise<void>((resolve) => googleServer.once("listening", resolve)),
    ]);
    const address = server.address();
    const googleAddress = googleServer.address();
    if (!address || typeof address === "string" || !googleAddress || typeof googleAddress === "string") {
      throw new Error("Test server did not bind to a TCP port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    googleBaseUrl = `http://127.0.0.1:${googleAddress.port}`;
  });

  afterAll(async () => {
    await Promise.all([server, googleServer].map((runningServer) =>
      new Promise<void>((resolve, reject) => {
        runningServer.close((error) => (error ? reject(error) : resolve()));
      }),
    ));
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
    expect(await login.text()).toContain('id="google-sign-in"');
    expect(register.status).toBe(200);
    expect(await register.text()).toContain('id="google-sign-in"');
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
    expect(await login.text()).toContain('id="google-sign-in"');
    expect(register.status).toBe(200);
    expect(await register.text()).toContain('id="google-sign-in"');
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

  it("rejects protected routes without a session cookie", async () => {
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

  it("reports missing Google OAuth configuration", async () => {
    const response = await fetch(`${baseUrl}/api/auth/google`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Google sign-in has not been configured." });
  });

  it("starts Google OAuth with state and nonce cookies", async () => {
    const response = await fetch(`${googleBaseUrl}/api/auth/google`, { redirect: "manual" });
    const authorizationUrl = new URL(response.headers.get("location") ?? "");
    const cookies = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("redirect_uri"))
      .toBe("http://localhost:5173/api/auth/google/callback");
    expect(authorizationUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookies).toContain("dis_google_state=");
    expect(cookies).toContain("dis_google_nonce=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=Lax");
  });

  it("allows health checks and Google OAuth without Stripe configuration", async () => {
    const [health, google] = await Promise.all([
      fetch(`${googleBaseUrl}/health`),
      fetch(`${googleBaseUrl}/api/auth/google`, { redirect: "manual" }),
    ]);

    expect(health.status).toBe(200);
    expect(google.status).toBe(302);
    expect(new URL(google.headers.get("location") ?? "").origin)
      .toBe("https://accounts.google.com");
  });

  it("reports Stripe webhooks as unavailable when payments are not configured", async () => {
    const response = await fetch(`${googleBaseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Stripe payments are not configured." });
  });

  it("rejects a Google callback without the matching state cookie", async () => {
    const response = await fetch(
      `${googleBaseUrl}/api/auth/google/callback?code=unused&state=attacker-state`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/login.html?error=google");
    expect(response.headers.get("set-cookie")).toContain("dis_google_state=");
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
