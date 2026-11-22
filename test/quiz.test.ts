import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { PointSourceType, QuizStatus, UserRole, type PrismaClient } from "@prisma/client";
import { createApp } from "../src/app-factory";
import type { AppConfig } from "../src/config";
import { hashSessionToken } from "../src/auth";

describe("Quiz game: server-side scoring, server-side timer, and daily cap", () => {
  const memberToken = "1".repeat(64);
  const csrfToken = "c".repeat(64);

  const mockQuiz = {
    id: "quiz-1",
    title: "Weekly Tech Trivia",
    status: QuizStatus.LIVE,
    questions: [
      {
        id: "q1",
        position: 1,
        prompt: "What does HTML stand for?",
        timeLimitSeconds: 30,
        options: [
          { id: "o1", text: "HyperText Markup Language", isCorrect: true },
          { id: "o2", text: "HighText Machine Language", isCorrect: false },
        ],
      },
      {
        id: "q2",
        position: 2,
        prompt: "What is 2 + 2?",
        timeLimitSeconds: 30,
        options: [
          { id: "o3", text: "4", isCorrect: true },
          { id: "o4", text: "5", isCorrect: false },
        ],
      },
    ],
  };

  let joinedAt = new Date();
  let todayGamePoints = 0;
  const pointTxCreate = vi.fn().mockResolvedValue({ id: "tx-1" });
  const userUpdate = vi.fn().mockResolvedValue({ id: "user-1", points: 10 });

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
        return Promise.resolve(null);
      }),
      deleteMany: vi.fn(),
    },
    quiz: {
      findFirst: vi.fn().mockResolvedValue(mockQuiz),
      findUnique: vi.fn().mockResolvedValue(mockQuiz),
    },
    quizParticipant: {
      upsert: vi.fn().mockImplementation(({ create }) => {
        joinedAt = create.joinedAt;
        return Promise.resolve({ id: "part-1", joinedAt });
      }),
      findUnique: vi.fn().mockImplementation(() => Promise.resolve({ id: "part-1", joinedAt })),
      update: vi.fn().mockResolvedValue({ id: "part-1" }),
    },
    quizAnswer: {
      upsert: vi.fn().mockResolvedValue({ id: "ans-1" }),
    },
    pointTransaction: {
      aggregate: vi.fn().mockImplementation(() => Promise.resolve({ _sum: { amount: todayGamePoints } })),
      create: pointTxCreate,
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ points: 10 }),
      update: userUpdate,
    },
    attendance: {
      count: vi.fn().mockResolvedValue(0),
    },
    resource: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    userBadge: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn().mockImplementation(async (callback) => {
      return callback({
        quizAnswer: { upsert: vi.fn() },
        quizParticipant: { update: vi.fn() },
        pointTransaction: { create: pointTxCreate },
        user: { findUnique: vi.fn().mockResolvedValue({ points: 10 }), update: userUpdate },
        attendance: { count: vi.fn().mockResolvedValue(0) },
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

  it("never sends isCorrect to the client when fetching quiz questions", async () => {
    const response = await fetch(`${baseUrl}/api/games/quiz`, {
      headers: { cookie: `dis_session=${memberToken}` },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.questions.length).toBe(2);

    for (const q of data.questions) {
      for (const opt of q.options) {
        expect(opt).toHaveProperty("id");
        expect(opt).toHaveProperty("text");
        expect(opt).not.toHaveProperty("isCorrect");
      }
    }
  });

  it("scores questions on the server and awards points up to the daily cap", async () => {
    todayGamePoints = 15; // User already earned 15 points today; cap is 20, so max 5 can be awarded

    // 1. Start quiz
    await fetch(`${baseUrl}/api/games/quiz/start`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ quizId: "quiz-1" }),
    });

    // 2. Submit both correct answers (2 * 5 = 10 raw points)
    const response = await fetch(`${baseUrl}/api/games/quiz/submit`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        quizId: "quiz-1",
        answers: [
          { questionId: "q1", optionId: "o1" },
          { questionId: "q2", optionId: "o3" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.correctCount).toBe(2);
    // Raw points = 10, but cap room was 5 (20 - 15 = 5)
    expect(result.pointsAwarded).toBe(5);
    expect(result.dailyCapReached).toBe(true);
    expect(pointTxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: 5,
          sourceType: PointSourceType.QUIZ_GAME,
        }),
      }),
    );
  });

  it("enforces server-side timer: rejects/scores 0 if submission is past time limit", async () => {
    // Participant started 5 minutes ago (allowed was 60s + 10s grace)
    joinedAt = new Date(Date.now() - 5 * 60 * 1000);

    const response = await fetch(`${baseUrl}/api/games/quiz/submit`, {
      method: "POST",
      headers: {
        cookie: `dis_session=${memberToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        quizId: "quiz-1",
        answers: [{ questionId: "q1", optionId: "o1" }],
      }),
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.isTimeout).toBe(true);
    expect(result.correctCount).toBe(0);
    expect(result.pointsAwarded).toBe(0);
  });
});
