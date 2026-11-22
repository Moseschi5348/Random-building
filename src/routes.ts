import { Router, type Request, type Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import {
  CommunityGameKey,
  CommunityMeetupKey,
  CommunityRequestStatus,
  NoticeLevel,
  PointSourceType,
  QuizStatus,
  ResourceCategory,
  UserRole,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  clearSessionCookie,
  createSessionCredentials,
  permissionsForRole,
  readCookie,
  requireAuth,
  requirePermission,
  requireRole,
  setSessionCookie,
} from "./auth";
import type { AppConfig } from "./config";
import { HttpError, parseBody } from "./http";
import { z } from "zod";

const departmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  icon: z.string().trim().max(16).default("◈"),
  headId: z.string().min(1).optional().nullable(),
});

const meetingSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000),
  startsAt: z.string().datetime().transform((value) => new Date(value)),
  endsAt: z.string().datetime().transform((value) => new Date(value)),
  departmentId: z.string().min(1).optional().nullable(),
});

const meetingCodeCheckinSchema = z.object({
  code: z.string().trim().min(4).max(12),
});

const manualAttendanceSchema = z.object({
  userId: z.string().min(1),
});

const resourceSchema = z.object({
  title: z.string().trim().min(1).max(160),
  url: z.string().trim().url().max(2000),
  category: z.nativeEnum(ResourceCategory).default(ResourceCategory.OTHER),
});

const noticeSchema = z.object({
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(2000),
  level: z.enum(["emergency", "important", "general"]),
  endsAt: z.string().datetime().transform((value) => new Date(value)).optional(),
});

const adminUsersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const quizSubmitSchema = z.object({
  quizId: z.string().min(1),
  answers: z.array(
    z.object({
      questionId: z.string().min(1),
      optionId: z.string().min(1),
    }),
  ),
});

const GOOGLE_STATE_COOKIE = "dis_google_state";
const GOOGLE_NONCE_COOKIE = "dis_google_nonce";
const GOOGLE_AUTH_COOKIE_TTL_SECONDS = 600;

// Rate limiting in-memory map for meeting code attempts: key = `${userId}:${meetingId}` -> { count, expiresAt }
const checkinAttempts = new Map<string, { count: number; expiresAt: number }>();

function assertCheckinRateLimit(userId: string, meetingId: string): void {
  const key = `${userId}:${meetingId}`;
  const now = Date.now();
  const record = checkinAttempts.get(key);
  if (record && record.expiresAt > now) {
    if (record.count >= 5) {
      throw new HttpError(429, "Too many failed code attempts. Please wait 10 minutes before trying again.");
    }
  } else {
    checkinAttempts.set(key, { count: 0, expiresAt: now + 10 * 60 * 1000 });
  }
}

function recordFailedCheckinAttempt(userId: string, meetingId: string): void {
  const key = `${userId}:${meetingId}`;
  const record = checkinAttempts.get(key);
  if (record) {
    record.count += 1;
  }
}

function clearCheckinAttempts(userId: string, meetingId: string): void {
  checkinAttempts.delete(`${userId}:${meetingId}`);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function setGoogleAuthCookie(res: Response, name: string, value: string, secure: boolean): void {
  res.append(
    "Set-Cookie",
    `${name}=${value}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${GOOGLE_AUTH_COOKIE_TTL_SECONDS}${secure ? "; Secure" : ""}`,
  );
}

function clearGoogleAuthCookies(res: Response, secure: boolean): void {
  for (const name of [GOOGLE_STATE_COOKIE, GOOGLE_NONCE_COOKIE]) {
    res.append(
      "Set-Cookie",
      `${name}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`,
    );
  }
}

function loginPageUrl(clientUrl: string, error: string): string {
  const url = new URL("/login.html", clientUrl);
  url.searchParams.set("error", error);
  return url.toString();
}

function currentUserId(req: Request): string {
  if (!req.user) {
    throw new HttpError(401, "Authentication is required.");
  }
  return req.user.id;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value;
}

async function createLoginSession(
  prisma: PrismaClient,
  userId: string,
  secureCookie: boolean,
  res: Response,
): Promise<void> {
  const credentials = createSessionCredentials();
  await prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  await prisma.session.create({
    data: {
      userId,
      tokenHash: credentials.tokenHash,
      csrfToken: credentials.csrfToken,
      expiresAt: credentials.expiresAt,
    },
  });
  setSessionCookie(res, credentials.token, secureCookie);
}

export async function awardPoints(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  reason: string,
  sourceType: PointSourceType,
  sourceId?: string,
): Promise<number> {
  if (amount <= 0) return 0;
  await tx.pointTransaction.create({
    data: {
      userId,
      amount,
      reason,
      sourceType,
      sourceId,
    },
  });
  await tx.user.update({
    where: { id: userId },
    data: { points: { increment: amount } },
  });
  return amount;
}

export async function evaluateBadges(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string[]> {
  const [attendanceCount, punctualCount, user, resources] = await Promise.all([
    tx.attendance.count({ where: { userId } }),
    tx.attendance.count({ where: { userId, punctual: true } }),
    tx.user.findUnique({ where: { id: userId }, select: { points: true } }),
    tx.resource.findMany({ where: { userId }, select: { createdAt: true } }),
  ]);

  const earnedBadges: string[] = [];
  if (attendanceCount >= 1) earnedBadges.push("FIRST_STEP");
  if (attendanceCount >= 5) earnedBadges.push("REGULAR");
  if (attendanceCount >= 10) earnedBadges.push("COMMITTED");
  if (punctualCount >= 5) earnedBadges.push("EARLY_BIRD");

  const points = user?.points ?? 0;
  if (points >= 100) earnedBadges.push("CENTURY_CLUB");
  if (points >= 250) earnedBadges.push("ACHIEVER");
  if (points >= 500) earnedBadges.push("CLUB_LEGEND");

  // CONTRIBUTOR: shared resources across >= 3 distinct calendar days
  const distinctDays = new Set(resources.map((r) => r.createdAt.toISOString().slice(0, 10)));
  if (distinctDays.size >= 3) {
    earnedBadges.push("CONTRIBUTOR");
  }

  if (earnedBadges.length > 0) {
    await tx.userBadge.createMany({
      data: earnedBadges.map((key) => ({ userId, key })),
      skipDuplicates: true,
    });
  }

  return earnedBadges;
}

export function createApiRouter(
  prisma: PrismaClient,
  config: AppConfig,
): Router {
  const router = Router();
  const auth = requireAuth(prisma);
  const googleOAuth = config.google
    ? new OAuth2Client(
        config.google.clientId,
        config.google.clientSecret,
        config.google.callbackUrl,
      )
    : null;

  // ---------------------------------------------------------
  // AUTH
  // ---------------------------------------------------------

  router.get("/auth/google", (_req, res) => {
    if (!googleOAuth) {
      throw new HttpError(503, "Google sign-in has not been configured.");
    }

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const secure = config.nodeEnv === "production";
    setGoogleAuthCookie(res, GOOGLE_STATE_COOKIE, state, secure);
    setGoogleAuthCookie(res, GOOGLE_NONCE_COOKIE, nonce, secure);
    res.redirect(302, googleOAuth.generateAuthUrl({
      access_type: "online",
      prompt: "select_account",
      scope: ["openid", "email", "profile"],
      state,
      nonce,
    }));
  });

  router.get("/auth/google/callback", async (req, res) => {
    const secure = config.nodeEnv === "production";
    const storedState = readCookie(req, GOOGLE_STATE_COOKIE);
    const storedNonce = readCookie(req, GOOGLE_NONCE_COOKIE);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    clearGoogleAuthCookies(res, secure);

    if (!googleOAuth || !config.google) {
      throw new HttpError(503, "Google sign-in has not been configured.");
    }
    if (!storedState || !storedNonce || !safeEqual(state, storedState)) {
      res.redirect(302, loginPageUrl(config.clientUrl, "google"));
      return;
    }
    if (typeof req.query.error === "string" || typeof req.query.code !== "string") {
      res.redirect(302, loginPageUrl(config.clientUrl, "google"));
      return;
    }

    let idToken: string | undefined;
    try {
      const { tokens } = await googleOAuth.getToken(req.query.code);
      idToken = tokens.id_token ?? undefined;
    } catch (error) {
      console.error("Google authorization code exchange failed.", error);
      res.redirect(302, loginPageUrl(config.clientUrl, "google"));
      return;
    }
    if (!idToken) {
      res.redirect(302, loginPageUrl(config.clientUrl, "google"));
      return;
    }

    let payload:
      | {
          sub: string;
          email?: string;
          email_verified?: boolean;
          nonce?: string;
          name?: string;
        }
      | undefined;
    try {
      const ticket = await googleOAuth.verifyIdToken({
        idToken,
        audience: config.google.clientId,
      });
      payload = ticket.getPayload();
    } catch (error) {
      console.error("Google identity token verification failed.", error);
      res.redirect(302, loginPageUrl(config.clientUrl, "google"));
      return;
    }

    const email = payload?.email?.trim().toLowerCase();
    if (
      !payload?.sub ||
      !email ||
      payload.email_verified !== true ||
      !payload.nonce ||
      !safeEqual(payload.nonce, storedNonce) ||
      !z.string().email().safeParse(email).success
    ) {
      res.redirect(302, loginPageUrl(config.clientUrl, "google"));
      return;
    }

    // Optional email domain restriction
    if (config.allowedEmailDomains.length > 0) {
      const domain = email.split("@")[1];
      if (!config.allowedEmailDomains.includes(domain)) {
        res.redirect(302, loginPageUrl(config.clientUrl, "domain_restricted"));
        return;
      }
    }

    const userSelect = {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      emailVerified: true,
      googleId: true,
    } as const;
    let user = await prisma.user.findUnique({
      where: { googleId: payload.sub },
      select: userSelect,
    });

    if (user && !user.isActive) {
      res.redirect(302, loginPageUrl(config.clientUrl, "google"));
      return;
    }

    if (user && user.email !== email) {
      const emailOwner = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (emailOwner && emailOwner.id !== user.id) {
        res.redirect(302, loginPageUrl(config.clientUrl, "google"));
        return;
      }
      user = await prisma.user.update({
        where: { id: user.id },
        data: { email, emailVerified: true },
        select: userSelect,
      });
    } else if (!user) {
      const existing = await prisma.user.findUnique({
        where: { email },
        select: userSelect,
      });
      if (
        existing &&
        (!existing.isActive || (existing.googleId && existing.googleId !== payload.sub))
      ) {
        res.redirect(302, loginPageUrl(config.clientUrl, "google"));
        return;
      }
      if (existing) {
        user = await prisma.user.update({
          where: { id: existing.id },
          data: { googleId: payload.sub, emailVerified: true },
          select: userSelect,
        });
      } else {
        user = await prisma.user.create({
          data: {
            email,
            googleId: payload.sub,
            name: (payload.name || email.split("@")[0]).slice(0, 120),
            emailVerified: true,
            role: UserRole.MEMBER,
          },
          select: userSelect,
        });
      }
    }

    if (!user.isActive) {
      res.redirect(302, loginPageUrl(config.clientUrl, "google"));
      return;
    }

    if (!user.emailVerified) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
        select: userSelect,
      });
    }
    if (config.adminEmail === user.email && user.role !== UserRole.ADMIN) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { role: UserRole.ADMIN },
        select: userSelect,
      });
    }

    await createLoginSession(prisma, user.id, secure, res);
    res.redirect(302, new URL("/home.html", config.clientUrl).toString());
  });

  router.get("/auth/session", auth, requirePermission("student-life:read"), async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: currentUserId(req) },
      select: {
        id: true,
        name: true,
        role: true,
        isActive: true,
        emailVerified: true,
        department: { select: { id: true, name: true, icon: true } },
        headedDepartment: { select: { id: true, name: true } },
      },
    });
    if (!user || !user.isActive) {
      throw new HttpError(401, "The account is unavailable.");
    }
    res.json({
      user: {
        id: user.id,
        displayName: user.name,
        role: user.role.toLowerCase().replaceAll("_", "-"),
        permissions: permissionsForRole(user.role),
        emailVerified: user.emailVerified,
        department: user.department,
        headedDepartment: user.headedDepartment,
      },
      csrfToken: req.user?.csrfToken ?? null,
    });
  });

  router.post("/auth/logout", auth, async (req, res) => {
    if (req.user?.sessionId) {
      await prisma.session.deleteMany({ where: { id: req.user.sessionId } });
    }
    clearSessionCookie(res, config.nodeEnv === "production");
    res.status(204).send();
  });

  // ---------------------------------------------------------
  // USER PROFILE
  // ---------------------------------------------------------

  router.get("/me", auth, requirePermission("student-life:read"), async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: currentUserId(req) },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        points: true,
        department: { select: { id: true, name: true, icon: true } },
        headedDepartment: { select: { id: true, name: true } },
        badges: { select: { key: true, awardedAt: true }, orderBy: { awardedAt: "desc" } },
        attendances: {
          select: {
            punctual: true,
            pointsAwarded: true,
            checkedInAt: true,
            meeting: {
              select: {
                id: true,
                title: true,
                startsAt: true,
                department: { select: { id: true, name: true, icon: true } },
              },
            },
          },
          orderBy: { checkedInAt: "desc" },
        },
        transactions: {
          select: { id: true, amount: true, reason: true, sourceType: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        _count: { select: { attendances: true, resources: true } },
      },
    });
    if (!user) {
      throw new HttpError(404, "User not found.");
    }
    res.json(user);
  });

  // ---------------------------------------------------------
  // DEPARTMENTS
  // ---------------------------------------------------------

  router.get("/departments", async (_req, res) => {
    const departments = await prisma.department.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        icon: true,
        head: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, meetings: true, resources: true } },
      },
    });
    res.json(departments);
  });

  // Backward compatibility alias for clubs
  router.get("/clubs", async (_req, res) => {
    const departments = await prisma.department.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        icon: true,
        head: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, meetings: true, resources: true } },
      },
    });
    res.json(departments.map((d) => ({ ...d, membershipFeeCents: 0, _count: { memberships: d._count.members } })));
  });

  router.post("/departments", auth, requireRole(UserRole.ADMIN), async (req, res) => {
    const body = parseBody(departmentSchema, req.body);
    const department = await prisma.$transaction(async (tx) => {
      if (body.headId) {
        const headCandidate = await tx.user.findUnique({ where: { id: body.headId } });
        if (!headCandidate) throw new HttpError(404, "Selected department head was not found.");
        if (headCandidate.role !== UserRole.ADMIN) {
          await tx.user.update({
            where: { id: headCandidate.id },
            data: { role: UserRole.DEPARTMENT_HEAD },
          });
        }
      }
      return tx.department.create({
        data: {
          name: body.name,
          description: body.description,
          icon: body.icon || "◈",
          headId: body.headId || null,
        },
        include: { head: { select: { id: true, name: true, email: true } } },
      });
    });
    res.status(201).json(department);
  });

  router.patch("/departments/:departmentId", auth, requireRole(UserRole.ADMIN), async (req, res) => {
    const departmentId = routeParam(req, "departmentId");
    const body = parseBody(departmentSchema.partial(), req.body);

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.department.findUnique({ where: { id: departmentId } });
      if (!existing) throw new HttpError(404, "Department not found.");

      if (body.headId !== undefined && body.headId !== existing.headId) {
        // Demote previous head if exists and not admin
        if (existing.headId) {
          const oldHead = await tx.user.findUnique({ where: { id: existing.headId } });
          if (oldHead && oldHead.role === UserRole.DEPARTMENT_HEAD) {
            await tx.user.update({
              where: { id: existing.headId },
              data: { role: UserRole.MEMBER },
            });
          }
        }
        // Promote new head
        if (body.headId) {
          const newHead = await tx.user.findUnique({ where: { id: body.headId } });
          if (!newHead) throw new HttpError(404, "New department head not found.");
          if (newHead.role !== UserRole.ADMIN) {
            await tx.user.update({
              where: { id: newHead.id },
              data: { role: UserRole.DEPARTMENT_HEAD },
            });
          }
        }
      }

      return tx.department.update({
        where: { id: departmentId },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.description ? { description: body.description } : {}),
          ...(body.icon ? { icon: body.icon } : {}),
          ...(body.headId !== undefined ? { headId: body.headId } : {}),
        },
        include: { head: { select: { id: true, name: true, email: true } } },
      });
    });

    res.json(updated);
  });

  // Member joins their one primary department
  router.post("/departments/:departmentId/join", auth, async (req, res) => {
    const userId = currentUserId(req);
    const departmentId = routeParam(req, "departmentId");

    const [user, department] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true } }),
      prisma.department.findUnique({ where: { id: departmentId } }),
    ]);

    if (!department) throw new HttpError(404, "Department not found.");

    if (user?.departmentId) {
      if (user.departmentId === department.id) {
        throw new HttpError(409, "You are already a member of this department.");
      }
      throw new HttpError(409, "You already belong to a department. Contact an administrator to change your department.");
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { departmentId: department.id },
      select: {
        id: true,
        name: true,
        department: { select: { id: true, name: true, icon: true } },
      },
    });

    res.status(201).json({ message: `Joined ${department.name} successfully.`, user: updatedUser });
  });

  // Backward compatibility alias for join club
  router.post("/clubs/:clubId/join", auth, async (req, res) => {
    const userId = currentUserId(req);
    const departmentId = routeParam(req, "clubId");
    const [user, department] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true } }),
      prisma.department.findUnique({ where: { id: departmentId } }),
    ]);
    if (!department) throw new HttpError(404, "Department not found.");
    if (user?.departmentId) {
      if (user.departmentId === department.id) {
        throw new HttpError(409, "You are already a member of this department.");
      }
      throw new HttpError(409, "You already belong to a department. Contact an administrator to change your department.");
    }
    await prisma.user.update({
      where: { id: userId },
      data: { departmentId: department.id },
    });
    res.status(201).json({ membership: { status: "ACTIVE", clubId: department.id } });
  });

  // Admin moves a member to a different department
  router.patch("/users/:userId/department", auth, requireRole(UserRole.ADMIN), async (req, res) => {
    const targetUserId = routeParam(req, "userId");
    const body = parseBody(z.object({ departmentId: z.string().min(1).nullable() }), req.body);

    if (body.departmentId) {
      const deptExists = await prisma.department.findUnique({ where: { id: body.departmentId } });
      if (!deptExists) throw new HttpError(404, "Target department not found.");
    }

    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: { departmentId: body.departmentId },
      select: {
        id: true,
        name: true,
        email: true,
        department: { select: { id: true, name: true, icon: true } },
      },
    });

    res.json(updated);
  });

  // ---------------------------------------------------------
  // MEETINGS & ATTENDANCE
  // ---------------------------------------------------------

  router.get("/meetings", async (req, res) => {
    const departmentId = typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
    const meetings = await prisma.meeting.findMany({
      where: departmentId ? { departmentId } : {},
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        title: true,
        description: true,
        startsAt: true,
        endsAt: true,
        departmentId: true,
        department: { select: { id: true, name: true, icon: true } },
        createdBy: { select: { id: true, name: true } },
        _count: { select: { attendances: true } },
      },
    });
    res.json(meetings);
  });

  // Backward compatibility alias for activities
  router.get("/activities", async (_req, res) => {
    const meetings = await prisma.meeting.findMany({
      where: { startsAt: { gt: new Date() } },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        title: true,
        description: true,
        startsAt: true,
        endsAt: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        _count: { select: { attendances: true } },
      },
    });
    res.json(meetings.map((m) => ({
      ...m,
      clubId: m.departmentId,
      club: m.department,
      registrationFeeCents: 0,
    })));
  });

  router.post("/meetings", auth, async (req, res) => {
    const userId = currentUserId(req);
    const body = parseBody(meetingSchema, req.body);
    const userRole = req.user?.role;

    if (body.endsAt <= body.startsAt) {
      throw new HttpError(400, "Meeting end time must be after the start time.");
    }

    // Permission check:
    // Admin can create for any department or all-club (departmentId null).
    // Department Head can only create for their own department.
    if (userRole === UserRole.DEPARTMENT_HEAD) {
      if (!body.departmentId) {
        throw new HttpError(403, "Department heads cannot create all-club meetings. Only admins can.");
      }
      const headed = await prisma.department.findUnique({
        where: { id: body.departmentId },
        select: { headId: true },
      });
      if (headed?.headId !== userId) {
        throw new HttpError(403, "You can only create meetings for your own department.");
      }
    } else if (userRole !== UserRole.ADMIN) {
      throw new HttpError(403, "Only department heads or administrators can create meetings.");
    }

    const meeting = await prisma.meeting.create({
      data: {
        title: body.title,
        description: body.description,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        departmentId: body.departmentId || null,
        createdById: userId,
      },
      include: {
        department: { select: { id: true, name: true, icon: true } },
      },
    });

    res.status(201).json(meeting);
  });

  // Generate / Activate a 6-digit attendance code for meeting
  router.post("/meetings/:meetingId/code", auth, async (req, res) => {
    const userId = currentUserId(req);
    const meetingId = routeParam(req, "meetingId");
    const userRole = req.user?.role;

    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: { department: { select: { headId: true } } },
    });
    if (!meeting) throw new HttpError(404, "Meeting not found.");

    // Only host, department head, or admin can generate the code
    const isAuthorized =
      userRole === UserRole.ADMIN ||
      meeting.createdById === userId ||
      meeting.department?.headId === userId;
    if (!isAuthorized) {
      throw new HttpError(403, "You are not authorized to generate the attendance code for this meeting.");
    }

    // Generate 6-digit code, expires at meeting end time (or 60 mins from now if end time has passed)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = meeting.endsAt > new Date() ? meeting.endsAt : new Date(Date.now() + 60 * 60 * 1000);

    const updated = await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        attendanceCode: code,
        codeExpiresAt: expiresAt,
      },
      select: {
        id: true,
        title: true,
        attendanceCode: true,
        codeExpiresAt: true,
      },
    });

    res.status(200).json(updated);
  });

  // Member checks in using the 6-digit code
  router.post("/meetings/:meetingId/checkin", auth, async (req, res) => {
    const userId = currentUserId(req);
    const meetingId = routeParam(req, "meetingId");
    const body = parseBody(meetingCodeCheckinSchema, req.body);

    assertCheckinRateLimit(userId, meetingId);

    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: { department: { select: { headId: true } } },
    });
    if (!meeting) throw new HttpError(404, "Meeting not found.");

    // Security rule: host and department heads cannot award points to themselves
    if (meeting.createdById === userId || meeting.department?.headId === userId) {
      throw new HttpError(403, "Meeting hosts and department heads cannot check in or award points to themselves.");
    }
    if (req.user?.role === UserRole.ADMIN && meeting.createdById === userId) {
      throw new HttpError(403, "You cannot record attendance or award points to yourself.");
    }

    const now = new Date();
    // Validate meeting window: valid from startsAt to endsAt
    if (now < meeting.startsAt || now > meeting.endsAt) {
      throw new HttpError(400, "Meeting attendance code is only valid during the meeting window.");
    }

    // Validate code active and not expired
    if (!meeting.attendanceCode || !meeting.codeExpiresAt || now > meeting.codeExpiresAt) {
      throw new HttpError(400, "The attendance code is expired or not active.");
    }

    // Validate code match
    if (meeting.attendanceCode.trim() !== body.code.trim()) {
      recordFailedCheckinAttempt(userId, meetingId);
      throw new HttpError(400, "Invalid attendance code.");
    }

    // Validate duplicate check-in
    const priorAttendance = await prisma.attendance.findUnique({
      where: { userId_meetingId: { userId, meetingId } },
    });
    if (priorAttendance) {
      throw new HttpError(409, "You have already checked in for this meeting.");
    }

    clearCheckinAttempts(userId, meetingId);

    // Punctual rule: entered within first 10 minutes of meeting start time
    const isPunctual = now.getTime() <= meeting.startsAt.getTime() + 10 * 60 * 1000;
    const pointsAwarded = isPunctual ? 15 : 10;

    const result = await prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.create({
        data: {
          userId,
          meetingId,
          punctual: isPunctual,
          pointsAwarded,
        },
      });

      await awardPoints(
        tx,
        userId,
        pointsAwarded,
        `Attended meeting: ${meeting.title}${isPunctual ? " (Punctual bonus)" : ""}`,
        PointSourceType.MEETING_ATTENDANCE,
        meetingId,
      );

      const badges = await evaluateBadges(tx, userId);
      return { attendance, badges };
    });

    res.status(201).json({
      message: isPunctual ? "Checked in! Earned 15 points (Punctual)." : "Checked in! Earned 10 points.",
      ...result,
    });
  });

  // Manual fallback attendance marked by Department Head or Admin
  router.post("/meetings/:meetingId/attendance", auth, async (req, res) => {
    const actorId = currentUserId(req);
    const meetingId = routeParam(req, "meetingId");
    const body = parseBody(manualAttendanceSchema, req.body);
    const userRole = req.user?.role;

    if (body.userId === actorId) {
      throw new HttpError(403, "You cannot record attendance or award points to yourself.");
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: { department: { select: { headId: true } } },
    });
    if (!meeting) throw new HttpError(404, "Meeting not found.");

    // Authorization check
    if (userRole === UserRole.DEPARTMENT_HEAD) {
      if (meeting.departmentId && meeting.department?.headId !== actorId && meeting.createdById !== actorId) {
        throw new HttpError(403, "You can only manage attendance for your department meetings.");
      }
      if (!meeting.departmentId) {
        throw new HttpError(403, "Only administrators can manage all-club activities.");
      }
    } else if (userRole !== UserRole.ADMIN && meeting.createdById !== actorId) {
      throw new HttpError(403, "Only department heads or administrators can record attendance.");
    }

    const priorAttendance = await prisma.attendance.findUnique({
      where: { userId_meetingId: { userId: body.userId, meetingId } },
    });
    if (priorAttendance) {
      throw new HttpError(409, "Attendance has already been recorded for this user.");
    }

    // Manual fallback is marked non-punctual per requirements
    const pointsAwarded = 10;
    const result = await prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.create({
        data: {
          userId: body.userId,
          meetingId,
          punctual: false,
          pointsAwarded,
        },
      });

      await awardPoints(
        tx,
        body.userId,
        pointsAwarded,
        `Manual check-in for meeting: ${meeting.title}`,
        PointSourceType.MEETING_ATTENDANCE,
        meetingId,
      );

      const badges = await evaluateBadges(tx, body.userId);
      return { attendance, badges };
    });

    res.status(201).json({
      message: "Attendance recorded successfully.",
      ...result,
    });
  });

  // Backward compatibility alias for activities/:activityId/attendance
  router.post("/activities/:activityId/attendance", auth, async (req, res) => {
    const actorId = currentUserId(req);
    const meetingId = routeParam(req, "activityId");
    const body = parseBody(z.object({ userId: z.string(), punctual: z.boolean().optional() }), req.body);
    const userRole = req.user?.role;

    if (body.userId === actorId) {
      throw new HttpError(403, "You cannot record attendance or award points to yourself.");
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: { department: { select: { headId: true } } },
    });
    if (!meeting) throw new HttpError(404, "Activity not found.");

    if (userRole === UserRole.DEPARTMENT_HEAD) {
      if (meeting.departmentId && meeting.department?.headId !== actorId && meeting.createdById !== actorId) {
        throw new HttpError(403, "Only this club's leader can manage its activities.");
      }
      if (!meeting.departmentId) {
        throw new HttpError(403, "Only administrators can manage all-club activities.");
      }
    } else if (userRole !== UserRole.ADMIN && meeting.createdById !== actorId) {
      throw new HttpError(403, "Only administrators can manage all-club activities.");
    }

    const prior = await prisma.attendance.findUnique({
      where: { userId_meetingId: { userId: body.userId, meetingId } },
    });
    if (prior) {
      throw new HttpError(409, "Attendance has already been recorded for this user.");
    }

    const isPunctual = body.punctual === true;
    const pointsAwarded = isPunctual ? 15 : 10;
    const result = await prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.create({
        data: {
          userId: body.userId,
          meetingId,
          punctual: isPunctual,
          pointsAwarded,
        },
      });

      await awardPoints(
        tx,
        body.userId,
        pointsAwarded,
        `Activity attendance: ${meeting.title}`,
        PointSourceType.MEETING_ATTENDANCE,
        meetingId,
      );

      const badges = await evaluateBadges(tx, body.userId);
      return { attendance, badges };
    });

    res.status(201).json(result);
  });

  // ---------------------------------------------------------
  // RESOURCES (PHASE 2)
  // ---------------------------------------------------------

  router.get("/departments/:departmentId/resources", async (req, res) => {
    const departmentId = routeParam(req, "departmentId");
    const resources = await prisma.resource.findMany({
      where: { departmentId },
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, role: true } },
      },
    });
    res.json(resources);
  });

  router.post("/departments/:departmentId/resources", auth, async (req, res) => {
    const userId = currentUserId(req);
    const departmentId = routeParam(req, "departmentId");
    const body = parseBody(resourceSchema, req.body);
    const userRole = req.user?.role;

    const [user, department] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true } }),
      prisma.department.findUnique({ where: { id: departmentId } }),
    ]);

    if (!department) throw new HttpError(404, "Department not found.");

    // Must be member of department, head, or admin
    const canPost =
      userRole === UserRole.ADMIN ||
      department.headId === userId ||
      user?.departmentId === department.id;
    if (!canPost) {
      throw new HttpError(403, "You must join this department before sharing resources here.");
    }

    const result = await prisma.$transaction(async (tx) => {
      const resource = await tx.resource.create({
        data: {
          title: body.title,
          url: body.url,
          category: body.category,
          departmentId,
          userId,
        },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      });

      const badges = await evaluateBadges(tx, userId);
      return { resource, badges };
    });

    res.status(201).json(result);
  });

  router.delete("/resources/:resourceId", auth, async (req, res) => {
    const userId = currentUserId(req);
    const resourceId = routeParam(req, "resourceId");
    const userRole = req.user?.role;

    const resource = await prisma.resource.findUnique({
      where: { id: resourceId },
      include: { department: { select: { headId: true } } },
    });
    if (!resource) throw new HttpError(404, "Resource not found.");

    const canDelete =
      userRole === UserRole.ADMIN ||
      resource.userId === userId ||
      resource.department.headId === userId;
    if (!canDelete) {
      throw new HttpError(403, "You are not authorized to delete this resource.");
    }

    await prisma.resource.delete({ where: { id: resourceId } });
    res.status(204).send();
  });

  // ---------------------------------------------------------
  // LEADERBOARD (PHASE 1)
  // ---------------------------------------------------------

  router.get("/leaderboard", auth, async (req, res) => {
    const limitResult = z.coerce.number().int().min(1).max(100).safeParse(req.query.limit ?? 25);
    if (!limitResult.success) {
      throw new HttpError(400, "limit must be between 1 and 100.");
    }
    const departmentId = typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;

    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        ...(departmentId ? { departmentId } : {}),
      },
      orderBy: [{ points: "desc" }, { name: "asc" }],
      take: limitResult.data,
      select: {
        id: true,
        name: true,
        points: true,
        role: true,
        department: { select: { id: true, name: true, icon: true } },
        _count: { select: { attendances: true, resources: true } },
      },
    });

    res.json(users);
  });

  router.get("/leaderboard/departments", auth, async (_req, res) => {
    const departments = await prisma.department.findMany({
      select: {
        id: true,
        name: true,
        icon: true,
        members: {
          where: { isActive: true },
          select: { points: true },
        },
        _count: { select: { members: true, meetings: true, resources: true } },
      },
    });

    const summary = departments
      .map((dept) => {
        const totalPoints = dept.members.reduce((acc, m) => acc + m.points, 0);
        return {
          id: dept.id,
          name: dept.name,
          icon: dept.icon,
          memberCount: dept._count.members,
          meetingCount: dept._count.meetings,
          resourceCount: dept._count.resources,
          totalPoints,
        };
      })
      .sort((a, b) => b.totalPoints - a.totalPoints);

    res.json(summary);
  });

  // ---------------------------------------------------------
  // QUIZ GAME (PHASE 3)
  // ---------------------------------------------------------

  // Returns live quiz questions WITHOUT answers
  router.get("/games/quiz", auth, async (_req, res) => {
    const quiz = await prisma.quiz.findFirst({
      where: { status: QuizStatus.LIVE },
      orderBy: { createdAt: "desc" },
      include: {
        questions: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            position: true,
            prompt: true,
            timeLimitSeconds: true,
            options: {
              select: {
                id: true,
                text: true,
                // CRITICAL: isCorrect is NEVER returned to client
              },
            },
          },
        },
      },
    });

    if (!quiz) {
      throw new HttpError(404, "No live quiz is currently available.");
    }

    res.json({
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      questions: quiz.questions.map((q) => ({
        id: q.id,
        position: q.position,
        prompt: q.prompt,
        timeLimitSeconds: q.timeLimitSeconds,
        options: q.options.map((opt) => ({ id: opt.id, text: opt.text })),
      })),
    });
  });

  // Participant starts quiz (records startedAt on server)
  router.post("/games/quiz/start", auth, async (req, res) => {
    const userId = currentUserId(req);
    const body = parseBody(z.object({ quizId: z.string().min(1) }), req.body);

    const quiz = await prisma.quiz.findUnique({
      where: { id: body.quizId },
      include: { questions: true },
    });
    if (!quiz || quiz.status !== QuizStatus.LIVE) {
      throw new HttpError(404, "Quiz is not currently available.");
    }

    // Check today's game cap: max 20 points per day
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayPoints = await prisma.pointTransaction.aggregate({
      where: {
        userId,
        sourceType: PointSourceType.QUIZ_GAME,
        createdAt: { gte: startOfDay },
      },
      _sum: { amount: true },
    });
    const currentDayPoints = todayPoints._sum.amount ?? 0;
    const pointsRemainingToday = Math.max(0, 20 - currentDayPoints);

    const startedAt = new Date();
    const participant = await prisma.quizParticipant.upsert({
      where: { quizId_userId: { quizId: quiz.id, userId } },
      create: {
        quizId: quiz.id,
        userId,
        score: 0,
        joinedAt: startedAt,
      },
      update: {
        joinedAt: startedAt,
        finishedAt: null,
      },
      select: { id: true, joinedAt: true },
    });

    res.json({
      participantId: participant.id,
      startedAt: participant.joinedAt,
      pointsRemainingToday,
    });
  });

  // Participant submits quiz (scored on server only, enforced server timer)
  router.post("/games/quiz/submit", auth, async (req, res) => {
    const userId = currentUserId(req);
    const body = parseBody(quizSubmitSchema, req.body);

    const quiz = await prisma.quiz.findUnique({
      where: { id: body.quizId },
      include: {
        questions: {
          include: { options: true },
        },
      },
    });
    if (!quiz) throw new HttpError(404, "Quiz not found.");

    const participant = await prisma.quizParticipant.findUnique({
      where: { quizId_userId: { quizId: quiz.id, userId } },
    });
    if (!participant) {
      throw new HttpError(400, "You must start the quiz before submitting answers.");
    }

    // Calculate total time allowed + 10s grace period for network latency
    const totalTimeLimitSeconds = quiz.questions.reduce((sum, q) => sum + q.timeLimitSeconds, 0);
    const allowedMs = (totalTimeLimitSeconds + 10) * 1000;
    const elapsedMs = Date.now() - participant.joinedAt.getTime();
    const isTimeout = elapsedMs > allowedMs;

    // Score on server only
    let correctCount = 0;
    const answerRecords: Array<{
      participantId: string;
      questionId: string;
      optionId: string;
      isCorrect: boolean;
      pointsAwarded: number;
    }> = [];

    const answerMap = new Map(body.answers.map((a) => [a.questionId, a.optionId]));

    for (const question of quiz.questions) {
      const selectedOptionId = answerMap.get(question.id);
      const correctOption = question.options.find((o) => o.isCorrect);
      const isCorrect = !isTimeout && selectedOptionId === correctOption?.id;

      if (isCorrect) correctCount++;

      if (selectedOptionId) {
        answerRecords.push({
          participantId: participant.id,
          questionId: question.id,
          optionId: selectedOptionId,
          isCorrect,
          pointsAwarded: isCorrect ? 5 : 0,
        });
      }
    }

    // Daily cap calculation (max 20 points per day)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayPoints = await prisma.pointTransaction.aggregate({
      where: {
        userId,
        sourceType: PointSourceType.QUIZ_GAME,
        createdAt: { gte: startOfDay },
      },
      _sum: { amount: true },
    });

    const currentDayPoints = todayPoints._sum.amount ?? 0;
    const availableCap = Math.max(0, 20 - currentDayPoints);
    const rawPoints = correctCount * 5;
    const pointsToAward = Math.min(rawPoints, availableCap);

    const result = await prisma.$transaction(async (tx) => {
      // Save answers
      for (const ans of answerRecords) {
        await tx.quizAnswer.upsert({
          where: {
            participantId_questionId: {
              participantId: ans.participantId,
              questionId: ans.questionId,
            },
          },
          create: ans,
          update: ans,
        });
      }

      await tx.quizParticipant.update({
        where: { id: participant.id },
        data: {
          score: correctCount,
          finishedAt: new Date(),
        },
      });

      if (pointsToAward > 0) {
        await awardPoints(
          tx,
          userId,
          pointsToAward,
          `Quiz: ${quiz.title} (${correctCount}/${quiz.questions.length} correct)`,
          PointSourceType.QUIZ_GAME,
          quiz.id,
        );
      }

      if (correctCount === quiz.questions.length && quiz.questions.length > 0) {
        await tx.userBadge.createMany({
          data: [{ userId, key: "QUIZ_MASTER" }],
          skipDuplicates: true,
        });
      }

      const badges = await evaluateBadges(tx, userId);
      return { badges };
    });

    res.json({
      correctCount,
      totalQuestions: quiz.questions.length,
      pointsAwarded: pointsToAward,
      isTimeout,
      dailyCapReached: currentDayPoints + pointsToAward >= 20,
      ...result,
    });
  });

  // Admin / Head creates a quiz question
  router.post("/admin/quizzes", auth, requireRole(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD), async (req, res) => {
    const userId = currentUserId(req);
    const schema = z.object({
      title: z.string().trim().min(1).max(160),
      description: z.string().trim().max(1000).optional(),
      questions: z.array(
        z.object({
          prompt: z.string().trim().min(1).max(1000),
          timeLimitSeconds: z.number().int().min(5).max(120).default(30),
          options: z.array(
            z.object({
              text: z.string().trim().min(1).max(300),
              isCorrect: z.boolean(),
            }),
          ).min(2).max(6),
        }),
      ).min(1),
    });

    const body = parseBody(schema, req.body);
    const created = await prisma.quiz.create({
      data: {
        title: body.title,
        description: body.description,
        status: QuizStatus.LIVE,
        createdById: userId,
        questions: {
          create: body.questions.map((q, idx) => ({
            position: idx + 1,
            prompt: q.prompt,
            timeLimitSeconds: q.timeLimitSeconds,
            options: {
              create: q.options,
            },
          })),
        },
      },
    });

    res.status(201).json(created);
  });

  // ---------------------------------------------------------
  // NOTICES & ADMIN OVERVIEW
  // ---------------------------------------------------------

  router.get(
    "/student-life/notices",
    auth,
    requirePermission("student-life:read"),
    async (_req, res) => {
      const now = new Date();
      const notices = await prisma.studentLifeNotice.findMany({
        where: {
          isActive: true,
          startsAt: { lte: now },
          OR: [{ endsAt: null }, { endsAt: { gte: now } }],
        },
        orderBy: { startsAt: "desc" },
        select: { level: true, title: true, message: true },
      });
      res.json({
        notices: notices.map((notice) => ({
          ...notice,
          level: notice.level.toLowerCase(),
        })),
      });
    },
  );

  router.post("/student-life/notices", auth, requireRole(UserRole.ADMIN), async (req, res) => {
    const body = parseBody(noticeSchema, req.body);
    if (body.endsAt && body.endsAt <= new Date()) {
      throw new HttpError(400, "Notice expiration must be in the future.");
    }
    const levels = {
      emergency: NoticeLevel.EMERGENCY,
      important: NoticeLevel.IMPORTANT,
      general: NoticeLevel.GENERAL,
    };
    const notice = await prisma.studentLifeNotice.create({
      data: {
        title: body.title,
        message: body.message,
        level: levels[body.level],
        endsAt: body.endsAt,
      },
    });
    res.status(201).json({
      notice: { ...notice, level: notice.level.toLowerCase() },
    });
  });

  router.get("/admin/overview", auth, requireRole(UserRole.ADMIN), async (req, res) => {
    const query = parseBody(adminUsersQuerySchema, req.query);
    const search = query.search || undefined;
    const userWhere = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};
    const now = new Date();
    const monthAgo = new Date(now);
    monthAgo.setDate(monthAgo.getDate() - 30);

    const [
      totalUsers,
      activeMembers,
      activeAccounts,
      newUsersLast30Days,
      totalAttendance,
      departmentsCount,
      matchingUsers,
      users,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: UserRole.MEMBER, isActive: true } }),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
      prisma.attendance.count(),
      prisma.department.count(),
      prisma.user.count({ where: userWhere }),
      prisma.user.findMany({
        where: userWhere,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          points: true,
          createdAt: true,
          department: { select: { id: true, name: true, icon: true } },
          _count: {
            select: {
              attendances: true,
              resources: true,
            },
          },
        },
      }),
    ]);

    res.json({
      summary: {
        totalUsers,
        activeMembers,
        activeAccounts,
        newUsersLast30Days,
        totalAttendance,
        departmentsCount,
      },
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.toLowerCase().replaceAll("_", "-"),
        isActive: user.isActive,
        points: user.points,
        createdAt: user.createdAt,
        department: user.department,
        counts: {
          attendances: user._count.attendances,
          resources: user._count.resources,
        },
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: matchingUsers,
        pages: Math.ceil(matchingUsers / query.limit),
      },
    });
  });

  router.patch("/users/:userId/role", auth, requireRole(UserRole.ADMIN), async (req, res) => {
    const body = parseBody(z.object({ role: z.nativeEnum(UserRole) }), req.body);
    const targetUserId = routeParam(req, "userId");
    if (targetUserId === currentUserId(req)) {
      throw new HttpError(400, "Administrators cannot change their own role.");
    }
    const user = await prisma.user.update({
      where: { id: targetUserId },
      data: { role: body.role },
      select: { id: true, name: true, email: true, role: true },
    });
    res.json(user);
  });

  // ---------------------------------------------------------
  // COMMUNITY INTEGRATION (RETAINED)
  // ---------------------------------------------------------

  router.get("/community/profile", auth, requirePermission("community:read"), async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: currentUserId(req) },
      select: { communityVisible: true, communityInterests: true },
    });
    if (!user) throw new HttpError(404, "User not found.");
    res.json({ visible: user.communityVisible, interests: user.communityInterests });
  });

  router.patch("/community/profile", auth, requirePermission("community:read"), async (req, res) => {
    const schema = z.object({
      visible: z.boolean(),
      interests: z.array(z.enum(["games", "study", "creative"])).max(3)
        .refine((interests) => new Set(interests).size === interests.length),
    });
    const body = parseBody(schema, req.body);
    const profile = await prisma.user.update({
      where: { id: currentUserId(req) },
      data: {
        communityVisible: body.visible,
        communityInterests: body.visible ? body.interests : [],
      },
      select: { communityVisible: true, communityInterests: true },
    });
    res.json({ visible: profile.communityVisible, interests: profile.communityInterests });
  });

  router.get("/community/peers", auth, requirePermission("community:read"), async (req, res) => {
    const userId = currentUserId(req);
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const interest = z.enum(["games", "study", "creative"]).safeParse(req.query.interest);
    if (req.query.interest !== undefined && !interest.success) {
      throw new HttpError(400, "Invalid community interest.");
    }

    const communityProfiles = await prisma.user.findMany({
      where: {
        id: { not: userId },
        isActive: true,
        emailVerified: true,
        role: { not: UserRole.ADMIN },
        OR: [
          {
            communityVisible: true,
            ...(interest.success && interest.data ? { communityInterests: { has: interest.data } } : {}),
          },
        ],
        ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
      },
      orderBy: { name: "asc" },
      take: 100,
      select: { id: true, name: true, communityVisible: true, communityInterests: true },
    });

    res.json(communityProfiles.map((p) => ({
      id: p.id,
      name: p.name,
      communityVisible: p.communityVisible,
      interests: p.communityInterests,
      connection: null,
      gameInvite: null,
    })));
  });

  router.post(
    "/community/connections/:userId",
    auth,
    requirePermission("community:read"),
    async (req, res) => {
      const requesterId = currentUserId(req);
      const recipientId = routeParam(req, "userId");
      if (requesterId === recipientId) {
        throw new HttpError(400, "You cannot send a connection request to yourself.");
      }
      const recipient = await prisma.user.findFirst({
        where: {
          id: recipientId,
          isActive: true,
          emailVerified: true,
          role: { not: UserRole.ADMIN },
          communityVisible: true,
        },
        select: { id: true },
      });
      if (!recipient) {
        throw new HttpError(404, "This student is not available for connection requests.");
      }

      const existing = await prisma.communityConnection.findFirst({
        where: {
          OR: [
            { requesterId, recipientId },
            { requesterId: recipientId, recipientId: requesterId },
          ],
        },
      });
      let connection;
      if (existing?.status === CommunityRequestStatus.PENDING) {
        if (existing.requesterId === recipientId) {
          connection = await prisma.communityConnection.update({
            where: { id: existing.id },
            data: { status: CommunityRequestStatus.ACCEPTED },
          });
        } else {
          throw new HttpError(409, "A connection request is already pending.");
        }
      } else if (existing?.status === CommunityRequestStatus.ACCEPTED) {
        throw new HttpError(409, "You are already connected.");
      } else if (existing) {
        connection = await prisma.communityConnection.update({
          where: { id: existing.id },
          data: {
            requesterId,
            recipientId,
            status: CommunityRequestStatus.PENDING,
          },
        });
      } else {
        connection = await prisma.communityConnection.create({
          data: { requesterId, recipientId },
        });
      }
      res.status(201).json({ connection });
    },
  );

  router.post("/community/game-invites", auth, requirePermission("community:read"), async (req, res) => {
    const body = parseBody(
      z.object({
        recipientId: z.string().min(1),
        game: z.nativeEnum(CommunityGameKey),
      }),
      req.body,
    );
    const senderId = currentUserId(req);
    if (senderId === body.recipientId) {
      throw new HttpError(400, "You cannot invite yourself to a game.");
    }
    const [recipient, connection] = await Promise.all([
      prisma.user.findFirst({
        where: {
          id: body.recipientId,
          isActive: true,
          emailVerified: true,
          role: { not: UserRole.ADMIN },
          communityVisible: true,
        },
        select: { id: true },
      }),
      prisma.communityConnection.findFirst({
        where: {
          status: CommunityRequestStatus.ACCEPTED,
          OR: [
            { requesterId: senderId, recipientId: body.recipientId },
            { requesterId: body.recipientId, recipientId: senderId },
          ],
        },
      }),
    ]);
    if (!recipient) {
      throw new HttpError(404, "This student is not available for game invitations.");
    }
    if (!connection) {
      throw new HttpError(403, "Connect with this student before sending a game invitation.");
    }
    const gameInvite = await prisma.communityGameInvite.create({
      data: { senderId, recipientId: body.recipientId, game: body.game },
    });
    res.status(201).json({ gameInvite });
  });

  router.get("/community/meetups", auth, requirePermission("community:read"), async (req, res) => {
    const userId = currentUserId(req);
    const [counts, mine] = await Promise.all([
      prisma.communityMeetupInterest.groupBy({
        by: ["meetup"],
        _count: { _all: true },
      }),
      prisma.communityMeetupInterest.findMany({
        where: { userId },
        select: { meetup: true },
      }),
    ]);
    const countByMeetup = new Map(counts.map((entry) => [entry.meetup, entry._count._all]));
    const myInterests = new Set(mine.map((entry) => entry.meetup));
    res.json([
      { key: CommunityMeetupKey.CHESS, interestedCount: countByMeetup.get(CommunityMeetupKey.CHESS) ?? 0 },
      { key: CommunityMeetupKey.ART, interestedCount: countByMeetup.get(CommunityMeetupKey.ART) ?? 0 },
    ].map((meetup) => ({ ...meetup, interested: myInterests.has(meetup.key) })));
  });

  router.patch(
    "/community/meetups/:meetup/interest",
    auth,
    requirePermission("community:read"),
    async (req, res) => {
      const meetup = z.nativeEnum(CommunityMeetupKey).safeParse(routeParam(req, "meetup"));
      if (!meetup.success) {
        throw new HttpError(400, "Invalid meetup.");
      }
      const body = parseBody(z.object({ interested: z.boolean() }), req.body);
      const userId = currentUserId(req);
      if (body.interested) {
        await prisma.communityMeetupInterest.upsert({
          where: { userId_meetup: { userId, meetup: meetup.data } },
          create: { userId, meetup: meetup.data },
          update: {},
        });
      } else {
        await prisma.communityMeetupInterest.deleteMany({
          where: { userId, meetup: meetup.data },
        });
      }
      const interestedCount = await prisma.communityMeetupInterest.count({
        where: { meetup: meetup.data },
      });
      res.json({ meetup: meetup.data, interested: body.interested, interestedCount });
    },
  );

  return router;
}
