import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { ResourceCategory, UserRole, type PrismaClient } from "@prisma/client";
import { createApp } from "../src/app-factory";
import type { AppConfig } from "../src/config";
import { hashSessionToken } from "../src/auth";

describe("Department shared resources and CONTRIBUTOR badge", () => {
  const memberToken = "1".repeat(64);
  const outsiderToken = "2".repeat(64);
  const csrfToken = "c".repeat(64);

  const mockDept = { id: "dept-design", name: "Design", headId: "head-1" };

  const resourceCreate = vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "res-1", ...data, user: { id: data.userId, name: "Author", role: "MEMBER" } }));
  const badgeCreateMany = vi.fn().mockResolvedValue({ count: 1 });

  const prisma = {
    session: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.tokenHash === hashSessionToken(memberToken)) {
          return Promise.resolve({
            id: "s-member",
            csrfToken,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: "user-member", role: UserRole.MEMBER, isActive: true, emailVerified: true },
          });
        }
        if (where.tokenHash === hashSessionToken(outsiderToken)) {
          return Promise.resolve({
            id: "s-outsider",
            csrfToken,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: "user-outsider", role: UserRole.MEMBER, isActive: true, emailVerified: true },
          });
        }
        return Promise.resolve(null);
      }),
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.id === "user-member") return Promise.resolve({ id: "user-member", departmentId: "dept-design", points: 20 });
        if (where.id === "user-outsider") return Promise.resolve({ id: "user-outsider", departmentId: "dept-dev", points: 0 });
        return Promise.resolve(null);
      }),
    },
    department: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.id === "dept-design") return Promise.resolve(mockDept);
        return Promise.resolve(null);
      }),
    },
    resource: {
      create: resourceCreate,
      findMany: vi.fn().mockResolvedValue([
        { id: "r1", createdAt: new Date("2026-11-01T10:00:00Z") },
        { id: "r2", createdAt: new Date("2026-11-02T10:00:00Z") },
        { id: "r3", createdAt: new Date("2026-11-03T10:00:00Z") },
      ]),
    },
    attendance: {
      count: vi.fn().mockResolvedValue(0),
    },
    userBadge: {
      createMany: badgeCreateMany,
    },
    $transaction: vi.fn().mockImplementation(async (callback) => {
      return callback({
        resource: { create: resourceCreate, findMany: vi.fn().mockResolvedValue([
          { id: "r1", createdAt: new Date("2026-11-01T10:00:00Z") },
          { id: "r2", createdAt: new Date("2026-11-02T10:00:00Z") },
          { id: "r3", createdAt: new Date("2026-11-03T10:00:00Z") },
        ]) },
        user: { findUnique: vi.fn().mockResolvedValue({ points: 20 }) },
        attendance: { count: vi.fn().mockResolvedValue(0) },
        userBadge: { createMany: badgeCreateMany },
      });
    }),
  } as unknown as PrismaClient;

  const config: AppConfig = {
    nodeEnv: "test",
    port: 0,
    databaseUrl: "postgresql://test:test@localhost:5432/test",
    directUrl: "postgresql://test:test@localhost:5432/test",
    clientUrl: "http://localhost:3000",
    corsOrigins: ["http://localhost:3000"],
    adminEmail: null,
    allowedEmailDomains: [],
    google: null,
  };

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp(prisma, config, express()).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server failed to bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("allows a department member to post a resource and unlocks CONTRIBUTOR badge on milestone", async () => {
    const response = await fetch(`${baseUrl}/api/departments/dept-design/resources`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Figma UI Kit",
        url: "https://figma.com/file/123",
        category: ResourceCategory.DESIGN,
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.resource.title).toBe("Figma UI Kit");
    expect(data.badges).toContain("CONTRIBUTOR");
    expect(badgeCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ key: "CONTRIBUTOR" })]),
      }),
    );
  });

  it("blocks non-department members from posting to another department", async () => {
    const response = await fetch(`${baseUrl}/api/departments/dept-design/resources`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${outsiderToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Malicious Post",
        url: "https://example.com",
        category: ResourceCategory.OTHER,
      }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("You must join this department before sharing resources here.");
  });

  it("rejects invalid resource URLs", async () => {
    const response = await fetch(`${baseUrl}/api/departments/dept-design/resources`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Bad Link",
        url: "not-a-valid-url",
        category: ResourceCategory.OTHER,
      }),
    });

    expect(response.status).toBe(400);
  });
});
