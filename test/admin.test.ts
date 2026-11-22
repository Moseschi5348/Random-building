import { UserRole, type PrismaClient } from "@prisma/client";
import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "../src/auth";
import { createApp } from "../src/app-factory";
import type { AppConfig } from "../src/config";

const sessionToken = "a".repeat(64);
const csrfToken = "b".repeat(64);
let sessionRole = UserRole.ADMIN;

const findMany = vi.fn().mockResolvedValue([
  {
    id: "student-1",
    name: "Alex Student",
    email: "alex@example.com",
    role: UserRole.MEMBER,
    isActive: true,
    points: 15,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    department: { id: "dept-1", name: "Development", icon: "💻" },
    _count: { attendances: 4, resources: 2 },
  },
]);
const userCount = vi.fn()
  .mockResolvedValueOnce(8)
  .mockResolvedValueOnce(5)
  .mockResolvedValueOnce(7)
  .mockResolvedValueOnce(2)
  .mockResolvedValueOnce(1);
const prisma = {
  session: {
    findUnique: vi.fn().mockImplementation(async () => ({
      id: "session-1",
      csrfToken,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: "admin-1", role: sessionRole, isActive: true, emailVerified: true },
    })),
    deleteMany: vi.fn(),
  },
  user: { count: userCount, findMany },
  attendance: { count: vi.fn().mockResolvedValue(24) },
  department: { count: vi.fn().mockResolvedValue(4) },
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

describe("administrator overview", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp(prisma, config, express()).listen(0, "127.0.0.1");
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

  it("requires authentication and an administrator role", async () => {
    const anonymous = await fetch(`${baseUrl}/api/admin/overview`);
    expect(anonymous.status).toBe(401);

    sessionRole = UserRole.MEMBER;
    const forbidden = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { cookie: `dis_session=${sessionToken}` },
    });
    expect(forbidden.status).toBe(403);
    sessionRole = UserRole.ADMIN;
  });

  it("returns account totals and paginated participation details to admins", async () => {
    const response = await fetch(`${baseUrl}/api/admin/overview?search=alex&page=1&limit=10`, {
      headers: { cookie: `dis_session=${sessionToken}` },
    });
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.summary).toEqual({
      totalUsers: 8,
      activeMembers: 5,
      activeAccounts: 7,
      newUsersLast30Days: 2,
      totalAttendance: 24,
      departmentsCount: 4,
    });
    expect(payload.users).toEqual([
      {
        id: "student-1",
        name: "Alex Student",
        email: "alex@example.com",
        role: "member",
        isActive: true,
        points: 15,
        createdAt: "2026-01-02T00:00:00.000Z",
        department: { id: "dept-1", name: "Development", icon: "💻" },
        counts: { attendances: 4, resources: 2 },
      },
    ]);
    expect(payload.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 1,
      pages: 1,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { name: { contains: "alex", mode: "insensitive" } },
            { email: { contains: "alex", mode: "insensitive" } },
          ],
        },
        skip: 0,
        take: 10,
      }),
    );
  });
});
