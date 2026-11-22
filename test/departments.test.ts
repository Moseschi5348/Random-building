import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { UserRole, type PrismaClient } from "@prisma/client";
import { createApp } from "../src/app-factory";
import type { AppConfig } from "../src/config";
import { hashSessionToken } from "../src/auth";

describe("Department management and membership rules", () => {
  const memberToken = "1".repeat(64);
  const adminToken = "2".repeat(64);
  const csrfToken = "c".repeat(64);

  let memberDeptId: string | null = null;
  const mockDeptDesign = { id: "dept-design", name: "Design", headId: null };
  const mockDeptDev = { id: "dept-dev", name: "Development", headId: null };

  const userFindUnique = vi.fn().mockImplementation(({ where }) => {
    if (where.id === "user-1") {
      return Promise.resolve({
        id: "user-1",
        name: "Test Member",
        role: UserRole.MEMBER,
        departmentId: memberDeptId,
      });
    }
    if (where.id === "candidate-1") {
      return Promise.resolve({
        id: "candidate-1",
        name: "Future Head",
        role: UserRole.MEMBER,
      });
    }
    return Promise.resolve(null);
  });

  const userUpdate = vi.fn().mockImplementation(({ where, data }) => {
    if (where.id === "user-1") {
      memberDeptId = data.departmentId ?? null;
      return Promise.resolve({ id: "user-1", departmentId: memberDeptId });
    }
    return Promise.resolve({ id: where.id, ...data });
  });

  const deptFindUnique = vi.fn().mockImplementation(({ where }) => {
    if (where.id === "dept-design") return Promise.resolve(mockDeptDesign);
    if (where.id === "dept-dev") return Promise.resolve(mockDeptDev);
    return Promise.resolve(null);
  });

  const deptUpdate = vi.fn().mockImplementation(({ where, data }) => {
    return Promise.resolve({ id: where.id, ...data, head: { id: data.headId, name: "Head", email: "head@example.com" } });
  });

  const prisma = {
    session: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.tokenHash === hashSessionToken(memberToken)) {
          return Promise.resolve({
            id: "s-member",
            csrfToken,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: "user-1", role: UserRole.MEMBER, isActive: true, emailVerified: true },
          });
        }
        if (where.tokenHash === hashSessionToken(adminToken)) {
          return Promise.resolve({
            id: "s-admin",
            csrfToken,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: "admin-1", role: UserRole.ADMIN, isActive: true, emailVerified: true },
          });
        }
        return Promise.resolve(null);
      }),
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
    department: {
      findUnique: deptFindUnique,
      findMany: vi.fn().mockResolvedValue([mockDeptDesign, mockDeptDev]),
      update: deptUpdate,
    },
    $transaction: vi.fn().mockImplementation(async (callback) => {
      return callback({
        user: { findUnique: userFindUnique, update: userUpdate },
        department: { findUnique: deptFindUnique, update: deptUpdate },
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

  it("allows a member to join a department for the first time", async () => {
    memberDeptId = null;
    const response = await fetch(`${baseUrl}/api/departments/dept-design/join`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
      },
    });

    expect(response.status).toBe(201);
    expect(memberDeptId).toBe("dept-design");
  });

  it("blocks a member from switching departments on their own", async () => {
    memberDeptId = "dept-design";
    const response = await fetch(`${baseUrl}/api/departments/dept-dev/join`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
      },
    });

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error).toBe("You already belong to a department. Contact an administrator to change your department.");
  });

  it("allows an admin to reassign a member's department", async () => {
    const response = await fetch(`${baseUrl}/api/users/user-1/department`, {
      method: "PATCH",
      headers: {
        cookie: `dis_session=${adminToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ departmentId: "dept-dev" }),
    });

    expect(response.status).toBe(200);
    expect(memberDeptId).toBe("dept-dev");
  });

  it("updates department head and promotes role in a single transaction", async () => {
    const response = await fetch(`${baseUrl}/api/departments/dept-dev`, {
      method: "PATCH",
      headers: {
        cookie: `dis_session=${adminToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ headId: "candidate-1" }),
    });

    expect(response.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "candidate-1" },
        data: { role: UserRole.DEPARTMENT_HEAD },
      }),
    );
  });
});
