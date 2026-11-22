import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UserRole, type PrismaClient } from "@prisma/client";
import { createSessionCredentials, hashSessionToken, requireAuth } from "../src/auth";

describe("cookie session authentication", () => {
  const csrfToken = "b".repeat(64);
  const sessionToken = "a".repeat(64);
  const sessionFindUnique = vi.fn().mockResolvedValue({
    id: "session-id",
    csrfToken,
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: "user-id", role: UserRole.MEMBER, isActive: true, emailVerified: true },
  });
  const prisma = {
    session: { findUnique: sessionFindUnique, deleteMany: vi.fn() },
  } as unknown as PrismaClient;
  const app = express();
  app.post("/", requireAuth(prisma), (_req, res) => res.sendStatus(204));

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = app.listen(0, "127.0.0.1");
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
  });

  it("creates random session and CSRF credentials without storing the raw session token", () => {
    const credentials = createSessionCredentials();
    expect(credentials.token).toMatch(/^[a-f0-9]{64}$/);
    expect(credentials.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(credentials.tokenHash).toBe(hashSessionToken(credentials.token));
    expect(credentials.tokenHash).not.toBe(credentials.token);
  });

  it("requires a CSRF token for cookie-authenticated state changes", async () => {
    const response = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { cookie: `dis_session=${sessionToken}` },
    });
    expect(response.status).toBe(403);
  });

  it("accepts the session-bound CSRF token", async () => {
    const response = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    expect(response.status).toBe(204);
    expect(sessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashSessionToken(sessionToken) } }),
    );
  });
});
