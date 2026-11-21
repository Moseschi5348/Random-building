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
  jwtSecret: "test-secret-at-least-thirty-two-characters",
  jwtExpiresIn: "15m",
  stripeSecretKey: "sk_test_dis_backend",
  stripeWebhookSecret: "whsec_dis_backend_test_secret",
  clientUrl: "http://localhost:5173",
  corsOrigins: ["http://localhost:5173"],
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
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects protected routes without a bearer token", async () => {
    const response = await fetch(`${baseUrl}/api/me`);
    expect(response.status).toBe(401);
  });

  it("rejects passwords that do not meet the minimum length", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Student", email: "student@example.com", password: "short" }),
    });
    expect(response.status).toBe(400);
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
