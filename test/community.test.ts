import { UserRole, type PrismaClient } from "@prisma/client";
import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "../src/auth";
import { createApp } from "../src/app-factory";
import type { AppConfig } from "../src/config";

const sessionToken = "a".repeat(64);
const csrfToken = "b".repeat(64);
let sessionVerified = true;
const profile = { communityVisible: false, communityInterests: [] as string[] };
const findPeers = vi.fn().mockResolvedValue([
  {
    id: "student-2",
    name: "Alex Student",
    communityVisible: true,
    communityInterests: ["games"],
  },
]);
const userUpdate = vi.fn().mockImplementation(async ({ data }) => ({
  communityVisible: data.communityVisible,
  communityInterests: data.communityInterests,
}));
const connectionFindMany = vi.fn().mockResolvedValue([]);
const gameInviteFindMany = vi.fn().mockResolvedValue([]);
const userFindFirst = vi.fn().mockResolvedValue({ id: "student-2" });
const connectionFindFirst = vi.fn().mockResolvedValue(null);
const connectionCreate = vi.fn().mockResolvedValue({ id: "connection-1", status: "PENDING" });
const gameInviteFindFirst = vi.fn().mockResolvedValue(null);
const gameInviteCreate = vi.fn().mockResolvedValue({ id: "invite-1", game: "CHESS", status: "PENDING" });
const meetupGroupBy = vi.fn().mockResolvedValue([{ meetup: "CHESS", _count: { _all: 3 } }]);
const meetupFindMany = vi.fn().mockResolvedValue([{ meetup: "ART" }]);
const meetupUpsert = vi.fn();
const meetupCount = vi.fn().mockResolvedValue(4);
const prisma = {
  session: {
    findUnique: vi.fn().mockImplementation(async () => ({
      id: "session-1",
      csrfToken,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: "student-1",
        role: UserRole.STUDENT,
        isActive: true,
        emailVerified: sessionVerified,
      },
    })),
    deleteMany: vi.fn(),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue(profile),
    findFirst: userFindFirst,
    findMany: findPeers,
    update: userUpdate,
  },
  communityConnection: {
    findMany: connectionFindMany,
    findFirst: connectionFindFirst,
    create: connectionCreate,
  },
  communityGameInvite: {
    findMany: gameInviteFindMany,
    findFirst: gameInviteFindFirst,
    create: gameInviteCreate,
  },
  communityMeetupInterest: {
    groupBy: meetupGroupBy,
    findMany: meetupFindMany,
    upsert: meetupUpsert,
    count: meetupCount,
  },
} as unknown as PrismaClient;
const config: AppConfig = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "postgresql://test:test@localhost:5432/test",
  directUrl: "postgresql://test:test@localhost:5432/test",
  stripe: null,
  clientUrl: "http://localhost:3000",
  corsOrigins: ["http://localhost:3000"],
  adminEmail: null,
  google: null,
};

describe("student community integration", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp(prisma, null, config, express()).listen(0, "127.0.0.1");
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

  it("requires a verified authenticated session for community profile data", async () => {
    const anonymous = await fetch(`${baseUrl}/api/community/profile`);
    expect(anonymous.status).toBe(401);

    const response = await fetch(`${baseUrl}/api/community/profile`, {
      headers: { cookie: `dis_session=${sessionToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ visible: false, interests: [] });
    expect(prisma.session.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashSessionToken(sessionToken) },
      include: {
        user: { select: { id: true, role: true, isActive: true, emailVerified: true } },
      },
    });

    sessionVerified = false;
    const unverified = await fetch(`${baseUrl}/api/community/profile`, {
      headers: { cookie: `dis_session=${sessionToken}` },
    });
    expect(unverified.status).toBe(403);
    sessionVerified = true;
  });

  it("saves explicit profile opt-in and rejects invalid interests", async () => {
    const rejected = await fetch(`${baseUrl}/api/community/profile`, {
      method: "PATCH",
      headers: {
        cookie: `dis_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ visible: true, interests: ["email"] }),
    });
    expect(rejected.status).toBe(400);

    const saved = await fetch(`${baseUrl}/api/community/profile`, {
      method: "PATCH",
      headers: {
        cookie: `dis_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ visible: true, interests: ["games", "study"] }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ visible: true, interests: ["games", "study"] });
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { communityVisible: true, communityInterests: ["games", "study"] },
    }));
  });

  it("returns only opted-in profile fields and saves connection requests", async () => {
    const peers = await fetch(`${baseUrl}/api/community/peers?interest=games`, {
      headers: { cookie: `dis_session=${sessionToken}` },
    });
    expect(peers.status).toBe(200);
    expect(await peers.json()).toEqual([{
      id: "student-2",
      name: "Alex Student",
      communityVisible: true,
      interests: ["games"],
      connection: null,
      gameInvite: null,
    }]);
    expect(findPeers).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        isActive: true,
        emailVerified: true,
        OR: expect.arrayContaining([
          expect.objectContaining({
            communityVisible: true,
            communityInterests: { has: "games" },
          }),
        ]),
      }),
    }));

    const request = await fetch(`${baseUrl}/api/community/connections/student-2`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    expect(request.status).toBe(201);
    expect(connectionCreate).toHaveBeenCalledWith({
      data: { requesterId: "student-1", recipientId: "student-2" },
    });
  });

  it("does not allow state-changing community requests without CSRF", async () => {
    userUpdate.mockClear();
    const response = await fetch(`${baseUrl}/api/community/profile`, {
      method: "PATCH",
      headers: {
        cookie: `dis_session=${sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ visible: true, interests: [] }),
    });
    expect(response.status).toBe(403);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("requires an accepted connection before creating game invitations", async () => {
    const inviteOptions = {
      method: "POST",
      headers: {
        cookie: `dis_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ recipientId: "student-2", game: "CHESS" }),
    };
    const rejected = await fetch(`${baseUrl}/api/community/game-invites`, inviteOptions);
    expect(rejected.status).toBe(403);
    expect(gameInviteCreate).not.toHaveBeenCalled();

    connectionFindFirst.mockResolvedValueOnce({ id: "connection-1", status: "ACCEPTED" });
    const created = await fetch(`${baseUrl}/api/community/game-invites`, inviteOptions);
    expect(created.status).toBe(201);
    expect(gameInviteCreate).toHaveBeenCalledWith({
      data: { senderId: "student-1", recipientId: "student-2", game: "CHESS" },
    });
  });

  it("loads meetup interest totals and saves the signed-in student's choice", async () => {
    const response = await fetch(`${baseUrl}/api/community/meetups`, {
      headers: { cookie: `dis_session=${sessionToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { key: "CHESS", interestedCount: 3, interested: false },
      { key: "ART", interestedCount: 0, interested: true },
    ]);

    const saved = await fetch(`${baseUrl}/api/community/meetups/CHESS/interest`, {
      method: "PATCH",
      headers: {
        cookie: `dis_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ interested: true }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ meetup: "CHESS", interested: true, interestedCount: 4 });
    expect(meetupUpsert).toHaveBeenCalledWith({
      where: { userId_meetup: { userId: "student-1", meetup: "CHESS" } },
      create: { userId: "student-1", meetup: "CHESS" },
      update: {},
    });
  });
});
