import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { UserRole, type PrismaClient } from "@prisma/client";
import { createApp } from "../src/app-factory";
import type { AppConfig } from "../src/config";
import { hashSessionToken } from "../src/auth";

describe("attendance and self-award security rules", () => {
  const sessionTokenLeader = "1".repeat(64);
  const sessionTokenAdmin = "2".repeat(64);
  const csrfToken = "c".repeat(64);

  const pastDate = new Date(Date.now() - 3600_000);

  const mockClub = {
    id: "club-1",
    name: "Development",
    leaderId: "leader-id",
  };

  const mockActivity = {
    id: "activity-1",
    clubId: "club-1",
    startsAt: pastDate,
  };

  const mockAllClubActivity = {
    id: "activity-all-club",
    clubId: null,
    startsAt: pastDate,
  };

  const attendanceFindUnique = vi.fn();
  const attendanceCreate = vi.fn().mockResolvedValue({ id: "att-1" });
  const userUpdate = vi.fn().mockResolvedValue({ id: "student-1", points: 10 });
  const attendanceCount = vi.fn().mockResolvedValue(1);
  const userBadgeCreateMany = vi.fn().mockResolvedValue({ count: 0 });

  const prisma = {
    session: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        const hash = where.tokenHash;
        if (hash === hashSessionToken(sessionTokenLeader)) {
          return Promise.resolve({
            id: "session-leader",
            csrfToken,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: "leader-id", role: UserRole.CLUB_LEADER, isActive: true, emailVerified: true },
          });
        }
        if (hash === hashSessionToken(sessionTokenAdmin)) {
          return Promise.resolve({
            id: "session-admin",
            csrfToken,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: "admin-id", role: UserRole.ADMIN, isActive: true, emailVerified: true },
          });
        }
        return Promise.resolve(null);
      }),
      deleteMany: vi.fn(),
    },
    club: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.id === "club-1") return Promise.resolve(mockClub);
        return Promise.resolve(null);
      }),
    },
    activity: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.id === "activity-1") return Promise.resolve(mockActivity);
        if (where.id === "activity-all-club") return Promise.resolve(mockAllClubActivity);
        return Promise.resolve(null);
      }),
    },
    activityRegistration: {
      findUnique: vi.fn().mockResolvedValue({ status: "CONFIRMED" }),
    },
    attendance: {
      findUnique: attendanceFindUnique,
      create: attendanceCreate,
      count: attendanceCount,
    },
    user: {
      update: userUpdate,
    },
    userBadge: {
      createMany: userBadgeCreateMany,
    },
    $transaction: vi.fn().mockImplementation(async (callback) => {
      return callback({
        attendance: { create: attendanceCreate, count: attendanceCount },
        user: { update: userUpdate },
        userBadge: { createMany: userBadgeCreateMany },
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
    google: null,
  };

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

  it("prevents a department head/leader from marking attendance or awarding points to themselves", async () => {
    const response = await fetch(`${baseUrl}/api/activities/activity-1/attendance`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${sessionTokenLeader}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: "leader-id" }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("You cannot record attendance or award points to yourself.");
  });

  it("prevents an administrator from marking attendance or awarding points to themselves", async () => {
    const response = await fetch(`${baseUrl}/api/activities/activity-1/attendance`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${sessionTokenAdmin}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: "admin-id" }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("You cannot record attendance or award points to yourself.");
  });

  it("prevents double check-in when attendance was already recorded", async () => {
    attendanceFindUnique.mockResolvedValueOnce({ id: "existing-attendance" });

    const response = await fetch(`${baseUrl}/api/activities/activity-1/attendance`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${sessionTokenLeader}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: "student-1" }),
    });

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error).toBe("Attendance has already been recorded for this user.");
  });

  it("prevents a club leader from managing an all-club meeting (only admins can manage)", async () => {
    attendanceFindUnique.mockResolvedValueOnce(null);

    const response = await fetch(`${baseUrl}/api/activities/activity-all-club/attendance`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${sessionTokenLeader}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: "student-1" }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Only administrators can manage all-club activities.");
  });

  it("allows an admin to record attendance for another member on an all-club meeting", async () => {
    attendanceFindUnique.mockResolvedValueOnce(null);

    const response = await fetch(`${baseUrl}/api/activities/activity-all-club/attendance`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${sessionTokenAdmin}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: "student-1", punctual: true }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.attendance.pointsAwarded).toBe(15);
  });
});
