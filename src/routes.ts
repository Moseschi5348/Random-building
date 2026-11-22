import { Router, type Request, type Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import {
  MembershipStatus,
  NoticeLevel,
  RegistrationStatus,
  UserRole,
  type PrismaClient,
} from "@prisma/client";
import type Stripe from "stripe";
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
import { applyStripeEvent, createCheckoutSession } from "./payments";
import { z } from "zod";

const clubSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  membershipFeeCents: z.number().int().min(0).max(1_000_000),
  leaderId: z.string().min(1),
});

const activitySchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000),
  startsAt: z.string().datetime().transform((value) => new Date(value)),
  registrationFeeCents: z.number().int().min(0).max(1_000_000),
});

const attendanceSchema = z.object({
  userId: z.string().min(1),
  punctual: z.boolean().default(false),
  goodConduct: z.boolean().default(false),
});

const noticeSchema = z.object({
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(2000),
  level: z.enum(["emergency", "important", "general"]),
  endsAt: z.string().datetime().transform((value) => new Date(value)).optional(),
});

const GOOGLE_STATE_COOKIE = "dis_google_state";
const GOOGLE_NONCE_COOKIE = "dis_google_nonce";
const GOOGLE_AUTH_COOKIE_TTL_SECONDS = 600;

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

async function assertClubManager(
  prisma: PrismaClient,
  clubId: string,
  userId: string,
  role: UserRole,
): Promise<void> {
  if (role === UserRole.ADMIN) {
    return;
  }
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { leaderId: true },
  });
  if (!club) {
    throw new HttpError(404, "Club not found.");
  }
  if (club.leaderId !== userId) {
    throw new HttpError(403, "Only this club's leader can manage its activities.");
  }
}

export function createApiRouter(
  prisma: PrismaClient,
  stripe: Stripe | null,
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

    await createLoginSession(prisma, user.id, secure, res);
    res.redirect(302, new URL("/home.html", config.clientUrl).toString());
  });

  router.get("/auth/session", auth, requirePermission("student-life:read"), async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: currentUserId(req) },
      select: { id: true, name: true, role: true, isActive: true, emailVerified: true },
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

  router.get("/me", auth, requirePermission("student-life:read"), async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: currentUserId(req) },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        points: true,
        badges: { select: { key: true, awardedAt: true } },
        memberships: {
          select: {
            status: true,
            createdAt: true,
            club: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        registrations: {
          select: {
            status: true,
            createdAt: true,
            activity: {
              select: {
                id: true,
                title: true,
                startsAt: true,
                club: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        _count: { select: { attendance: true } },
      },
    });
    if (!user) {
      throw new HttpError(404, "User not found.");
    }
    res.json(user);
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

  router.get("/clubs", async (_req, res) => {
    const clubs = await prisma.club.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        membershipFeeCents: true,
        leader: { select: { id: true, name: true } },
        _count: { select: { memberships: { where: { status: MembershipStatus.ACTIVE } } } },
      },
    });
    res.json(clubs);
  });

  router.post("/clubs", auth, requireRole(UserRole.ADMIN), async (req, res) => {
    const body = parseBody(clubSchema, req.body);
    const leader = await prisma.user.findUnique({
      where: { id: body.leaderId },
      select: { role: true, isActive: true },
    });
    if (!leader || !leader.isActive || leader.role !== UserRole.CLUB_LEADER) {
      throw new HttpError(400, "The selected leader must be an active club leader.");
    }
    const club = await prisma.club.create({ data: body });
    res.status(201).json(club);
  });

  router.post("/clubs/:clubId/join", auth, async (req, res) => {
    const userId = currentUserId(req);
    const clubId = routeParam(req, "clubId");
    const club = await prisma.club.findUnique({ where: { id: clubId } });
    if (!club) {
      throw new HttpError(404, "Club not found.");
    }

    const priorMembership = await prisma.membership.findUnique({
      where: { userId_clubId: { userId, clubId: club.id } },
    });
    if (
      priorMembership?.status === MembershipStatus.ACTIVE ||
      priorMembership?.status === MembershipStatus.PENDING
    ) {
      throw new HttpError(409, "You already have an active or pending club membership.");
    }
    if (club.membershipFeeCents > 0 && !stripe) {
      throw new HttpError(503, "Paid club memberships are not enabled.");
    }

    const membership = priorMembership
      ? await prisma.membership.update({
          where: { id: priorMembership.id },
          data: {
            status:
              club.membershipFeeCents === 0
                ? MembershipStatus.ACTIVE
                : MembershipStatus.PENDING,
          },
        })
      : await prisma.membership.create({
          data: {
            userId,
            clubId: club.id,
            status:
              club.membershipFeeCents === 0
                ? MembershipStatus.ACTIVE
                : MembershipStatus.PENDING,
          },
        });

    if (club.membershipFeeCents === 0) {
      res.status(201).json({ membership });
      return;
    }
    if (!stripe) {
      throw new HttpError(503, "Paid club memberships are not enabled.");
    }

    try {
      const checkout = await createCheckoutSession(
        prisma,
        stripe,
        config.clientUrl,
        userId,
        club.membershipFeeCents,
        { type: "MEMBERSHIP", membershipId: membership.id, label: `${club.name} membership` },
      );
      res.status(201).json({ membership, ...checkout });
    } catch (error) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { status: MembershipStatus.CANCELLED },
      });
      throw error;
    }
  });

  router.get("/clubs/:clubId/activities", async (req, res) => {
    const activities = await prisma.activity.findMany({
      where: { clubId: routeParam(req, "clubId") },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        clubId: true,
        title: true,
        description: true,
        startsAt: true,
        registrationFeeCents: true,
        _count: { select: { registrations: { where: { status: RegistrationStatus.CONFIRMED } } } },
      },
    });
    res.json(activities);
  });

  router.post("/clubs/:clubId/activities", auth, async (req, res) => {
    const userId = currentUserId(req);
    const body = parseBody(activitySchema, req.body);
    if (body.startsAt.getTime() <= Date.now()) {
      throw new HttpError(400, "Activity start time must be in the future.");
    }
    const role = req.user?.role;
    if (!role) {
      throw new HttpError(401, "Authentication is required.");
    }
    const clubId = routeParam(req, "clubId");
    await assertClubManager(prisma, clubId, userId, role);
    const activity = await prisma.activity.create({
      data: { ...body, clubId },
    });
    res.status(201).json(activity);
  });

  router.post("/activities/:activityId/register", auth, async (req, res) => {
    const userId = currentUserId(req);
    const activity = await prisma.activity.findUnique({
      where: { id: routeParam(req, "activityId") },
      include: { club: { select: { name: true } } },
    });
    if (!activity) {
      throw new HttpError(404, "Activity not found.");
    }
    if (activity.startsAt <= new Date()) {
      throw new HttpError(400, "Registration is closed for this activity.");
    }

    const prior = await prisma.activityRegistration.findUnique({
      where: { userId_activityId: { userId, activityId: activity.id } },
    });
    if (
      prior?.status === RegistrationStatus.CONFIRMED ||
      prior?.status === RegistrationStatus.PENDING
    ) {
      throw new HttpError(409, "You already have an active or pending registration.");
    }
    if (activity.registrationFeeCents > 0 && !stripe) {
      throw new HttpError(503, "Paid activity registrations are not enabled.");
    }

    const registration = prior
      ? await prisma.activityRegistration.update({
          where: { id: prior.id },
          data: {
            status:
              activity.registrationFeeCents === 0
                ? RegistrationStatus.CONFIRMED
                : RegistrationStatus.PENDING,
          },
        })
      : await prisma.activityRegistration.create({
          data: {
            userId,
            activityId: activity.id,
            status:
              activity.registrationFeeCents === 0
                ? RegistrationStatus.CONFIRMED
                : RegistrationStatus.PENDING,
          },
        });

    if (activity.registrationFeeCents === 0) {
      res.status(201).json({ registration });
      return;
    }
    if (!stripe) {
      throw new HttpError(503, "Paid activity registrations are not enabled.");
    }

    try {
      const checkout = await createCheckoutSession(
        prisma,
        stripe,
        config.clientUrl,
        userId,
        activity.registrationFeeCents,
        {
          type: "ACTIVITY",
          activityRegistrationId: registration.id,
          label: activity.title,
        },
      );
      res.status(201).json({ registration, ...checkout });
    } catch (error) {
      await prisma.activityRegistration.update({
        where: { id: registration.id },
        data: { status: RegistrationStatus.CANCELLED },
      });
      throw error;
    }
  });

  router.post("/activities/:activityId/attendance", auth, async (req, res) => {
    const body = parseBody(attendanceSchema, req.body);
    const actorId = currentUserId(req);
    const activity = await prisma.activity.findUnique({
      where: { id: routeParam(req, "activityId") },
      select: { id: true, clubId: true, startsAt: true },
    });
    if (!activity) {
      throw new HttpError(404, "Activity not found.");
    }
    if (activity.startsAt > new Date()) {
      throw new HttpError(400, "Attendance cannot be recorded before the activity starts.");
    }
    const actorRole = req.user?.role;
    if (!actorRole) {
      throw new HttpError(401, "Authentication is required.");
    }
    await assertClubManager(prisma, activity.clubId, actorId, actorRole);

    const registration = await prisma.activityRegistration.findUnique({
      where: { userId_activityId: { userId: body.userId, activityId: activity.id } },
    });
    if (registration?.status !== RegistrationStatus.CONFIRMED) {
      throw new HttpError(400, "Attendance can only be recorded for confirmed registrations.");
    }

    const pointsAwarded = 10 + (body.punctual ? 5 : 0) + (body.goodConduct ? 3 : 0);
    const result = await prisma.$transaction(async (tx) => {
      await tx.attendance.create({
        data: {
          userId: body.userId,
          activityId: activity.id,
          punctual: body.punctual,
          goodConduct: body.goodConduct,
          pointsAwarded,
        },
      });
      const user = await tx.user.update({
        where: { id: body.userId },
        data: { points: { increment: pointsAwarded } },
        select: { id: true, points: true },
      });

      const [participationCount, punctualCount, goodConductCount] = await Promise.all([
        tx.attendance.count({ where: { userId: body.userId } }),
        tx.attendance.count({ where: { userId: body.userId, punctual: true } }),
        tx.attendance.count({ where: { userId: body.userId, goodConduct: true } }),
      ]);
      const earnedBadges = [
        ...(participationCount >= 10 ? ["PARTICIPATION_10"] : []),
        ...(punctualCount >= 5 ? ["PUNCTUALITY_5"] : []),
        ...(goodConductCount >= 5 ? ["GOOD_CONDUCT_5"] : []),
      ];
      if (earnedBadges.length > 0) {
        await tx.userBadge.createMany({
          data: earnedBadges.map((key) => ({ userId: body.userId, key })),
          skipDuplicates: true,
        });
      }

      return { user, earnedBadges };
    });

    res.status(201).json({ attendance: { pointsAwarded }, ...result });
  });

  router.get("/leaderboard", auth, async (req, res) => {
    const limitResult = z.coerce.number().int().min(1).max(100).safeParse(req.query.limit ?? 20);
    if (!limitResult.success) {
      throw new HttpError(400, "limit must be an integer between 1 and 100.");
    }
    const users = await prisma.user.findMany({
      where: { isActive: true, role: { not: UserRole.ADMIN } },
      orderBy: [{ points: "desc" }, { name: "asc" }],
      take: limitResult.data,
      select: { id: true, name: true, points: true },
    });
    res.json(users);
  });

  router.post("/webhooks/stripe", async (req, res) => {
    if (!stripe || !config.stripe) {
      throw new HttpError(503, "Stripe payments are not configured.");
    }
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Invalid Stripe webhook request." });
      return;
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, config.stripe.webhookSecret);
    } catch {
      res.status(400).json({ error: "Invalid Stripe webhook signature." });
      return;
    }
    await applyStripeEvent(prisma, event);
    res.json({ received: true });
  });

  return router;
}
