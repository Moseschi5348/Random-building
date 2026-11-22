import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { PointSourceType, UserRole, type PrismaClient } from "@prisma/client";
import { createApp } from "../src/app-factory";
import type { AppConfig } from "../src/config";
import { hashSessionToken } from "../src/auth";

describe("Meeting attendance code check-in, punctuality, and ledger", () => {
  const memberToken = "1".repeat(64);
  const headToken = "2".repeat(64);
  const csrfToken = "c".repeat(64);

  const now = new Date();
  const meetingStartsAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 mins ago (punctual)
  const meetingEndsAt = new Date(now.getTime() + 55 * 60 * 1000); // 55 mins in future

  const mockMeeting = {
    id: "meeting-1",
    title: "Dev Sprint",
    startsAt: meetingStartsAt,
    endsAt: meetingEndsAt,
    departmentId: "dept-1",
    department: { headId: "head-1" },
    createdById: "head-1",
    attendanceCode: "123456",
    codeExpiresAt: meetingEndsAt,
  };

  const attendanceFindUnique = vi.fn();
  const attendanceCreate = vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "att-1", ...data }));
  const pointTxCreate = vi.fn().mockResolvedValue({ id: "tx-1" });
  const userUpdate = vi.fn().mockResolvedValue({ id: "member-1", points: 15 });

  const prisma = {
    session: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.tokenHash === hashSessionToken(memberToken)) {
          return Promise.resolve({
            id: "s-member",
            csrfToken,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: "member-1", role: UserRole.MEMBER, isActive: true, emailVerified: true },
          });
        }
        if (where.tokenHash === hashSessionToken(headToken)) {
          return Promise.resolve({
            id: "s-head",
            csrfToken,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: "head-1", role: UserRole.DEPARTMENT_HEAD, isActive: true, emailVerified: true },
          });
        }
        return Promise.resolve(null);
      }),
      deleteMany: vi.fn(),
    },
    meeting: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.id === "meeting-1") return Promise.resolve(mockMeeting);
        return Promise.resolve(null);
      }),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...mockMeeting, ...data })),
    },
    attendance: {
      findUnique: attendanceFindUnique,
      create: attendanceCreate,
      count: vi.fn().mockResolvedValue(1),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ points: 15 }),
      update: userUpdate,
    },
    resource: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    userBadge: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    pointTransaction: {
      create: pointTxCreate,
    },
    $transaction: vi.fn().mockImplementation(async (callback) => {
      return callback({
        attendance: { create: attendanceCreate, count: vi.fn().mockResolvedValue(1) },
        pointTransaction: { create: pointTxCreate },
        user: { findUnique: vi.fn().mockResolvedValue({ points: 15 }), update: userUpdate },
        resource: { findMany: vi.fn().mockResolvedValue([]) },
        userBadge: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
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

  it("allows head to generate attendance code", async () => {
    const response = await fetch(`${baseUrl}/api/meetings/meeting-1/code`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${headToken}`,
        "x-csrf-token": csrfToken,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.attendanceCode).toMatch(/^\d{6}$/);
  });

  it("awards 15 points (punctual) when member enters code within first 10 minutes", async () => {
    attendanceFindUnique.mockResolvedValueOnce(null);

    const response = await fetch(`${baseUrl}/api/meetings/meeting-1/checkin`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "123456" }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.attendance.punctual).toBe(true);
    expect(data.attendance.pointsAwarded).toBe(15);
    expect(pointTxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "member-1",
          amount: 15,
          sourceType: PointSourceType.MEETING_ATTENDANCE,
        }),
      }),
    );
  });

  it("prevents meeting host/head from checking in to own meeting", async () => {
    const response = await fetch(`${baseUrl}/api/meetings/meeting-1/checkin`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${headToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "123456" }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Meeting hosts and department heads cannot check in or award points to themselves.");
  });

  it("blocks duplicate check-in with 409 Conflict", async () => {
    attendanceFindUnique.mockResolvedValueOnce({ id: "already-checked-in" });

    const response = await fetch(`${baseUrl}/api/meetings/meeting-1/checkin`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "123456" }),
    });

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error).toBe("You have already checked in for this meeting.");
  });
});
