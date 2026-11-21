import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
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
  requireAuth,
  requirePermission,
  requireRole,
  setSessionCookie,
} from "./auth";
import type { AppConfig } from "./config";
import { GraphOtpMailer } from "./email";
import { HttpError, parseBody } from "./http";
import {
  createOtp,
  hashOtp,
  isSchoolEmail,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  verifyOtp,
} from "./otp";
import { applyStripeEvent, createCheckoutSession } from "./payments";
import { z } from "zod";

const schoolEmailSchema = z.string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase())
  .refine(isSchoolEmail, "Use your NUTM school email ending in @nutm.edu.ng.");

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: schoolEmailSchema,
  password: z.string().min(12).max(128),
});

const loginSchema = z.object({
  email: schoolEmailSchema,
  password: z.string().min(1).max(128),
});

const verifyEmailSchema = z.object({
  email: schoolEmailSchema,
  code: z.string().regex(/^\d{6}$/, "Enter the six-digit verification code."),
});

const resendVerificationSchema = z.object({ email: schoolEmailSchema });

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

const dummyPasswordHash = bcrypt.hashSync("unreachable-dummy-password", 12);

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

async function sendRegistrationCode(
  prisma: PrismaClient,
  mailer: GraphOtpMailer | null,
  email: string,
  name: string,
  passwordHash: string,
  otpHashSecret: string,
): Promise<void> {
  if (!mailer) {
    throw new HttpError(503, "Verification email delivery has not been configured.");
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { emailVerified: true },
  });
  if (user?.emailVerified) {
    throw new HttpError(409, "An account with this school email already exists. Sign in instead.");
  }

  const previous = await prisma.registrationChallenge.findUnique({ where: { email } });
  if (
    previous &&
    Date.now() - previous.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS
  ) {
    throw new HttpError(429, "Wait a minute before requesting another verification code.");
  }

  const code = createOtp();
  const otpHash = hashOtp(email, code, otpHashSecret);
  const now = new Date();
  await prisma.registrationChallenge.upsert({
    where: { email },
    update: {
      name,
      passwordHash,
      otpHash,
      attempts: 0,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      createdAt: now,
    },
    create: {
      email,
      name,
      passwordHash,
      otpHash,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      createdAt: now,
    },
  });

  try {
    await mailer.sendVerificationCode(email, code);
  } catch (error) {
    console.error("Microsoft Graph could not send a registration verification code.", error);
    throw new HttpError(502, "We couldn't send a verification code. Please try again later.");
  }
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
  stripe: Stripe,
  config: AppConfig,
): Router {
  const router = Router();
  const auth = requireAuth(prisma);
  const otpMailer = config.graph ? new GraphOtpMailer(config.graph) : null;

  router.post("/auth/register", async (req, res) => {
    const body = parseBody(registerSchema, req.body);
    if (!otpMailer) {
      throw new HttpError(503, "Verification email delivery has not been configured.");
    }
    const passwordHash = await bcrypt.hash(body.password, 12);
    await sendRegistrationCode(
      prisma,
      otpMailer,
      body.email,
      body.name,
      passwordHash,
      config.otpHashSecret,
    );
    res.status(202).json({ message: "A verification code was sent to your school email." });
  });

  router.post("/auth/resend-verification", async (req, res) => {
    const body = parseBody(resendVerificationSchema, req.body);
    const challenge = await prisma.registrationChallenge.findUnique({
      where: { email: body.email },
    });
    if (!challenge) {
      res.status(202).json({ message: "If the account is eligible, a new code has been sent." });
      return;
    }

    await sendRegistrationCode(
      prisma,
      otpMailer,
      challenge.email,
      challenge.name,
      challenge.passwordHash,
      config.otpHashSecret,
    );
    res.status(202).json({ message: "If the account is eligible, a new code has been sent." });
  });

  router.post("/auth/verify-email", async (req, res) => {
    const body = parseBody(verifyEmailSchema, req.body);
    const outcome = await prisma.$transaction(async (tx) => {
      const challenge = await tx.registrationChallenge.findUnique({
        where: { email: body.email },
      });
      if (!challenge) return { kind: "invalid" as const };

      const now = new Date();
      if (challenge.expiresAt <= now) {
        await tx.registrationChallenge.deleteMany({ where: { email: body.email } });
        return { kind: "expired" as const };
      }
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        return { kind: "locked" as const };
      }
      if (!verifyOtp(body.email, body.code, challenge.otpHash, config.otpHashSecret)) {
        const updated = await tx.registrationChallenge.updateMany({
          where: {
            email: body.email,
            otpHash: challenge.otpHash,
            attempts: { lt: OTP_MAX_ATTEMPTS },
            expiresAt: { gt: now },
          },
          data: { attempts: { increment: 1 } },
        });
        return { kind: updated.count === 1 ? "incorrect" as const : "locked" as const };
      }

      const claimed = await tx.registrationChallenge.deleteMany({
        where: {
          email: body.email,
          otpHash: challenge.otpHash,
          attempts: { lt: OTP_MAX_ATTEMPTS },
          expiresAt: { gt: now },
        },
      });
      if (claimed.count !== 1) return { kind: "invalid" as const };

      const existing = await tx.user.findUnique({ where: { email: body.email } });
      if (existing?.emailVerified) return { kind: "already-verified" as const };
      if (existing && !existing.isActive) return { kind: "inactive" as const };

      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              name: challenge.name,
              passwordHash: challenge.passwordHash,
              emailVerified: true,
            },
            select: { id: true, name: true, email: true, role: true },
          })
        : await tx.user.create({
            data: {
              email: body.email,
              name: challenge.name,
              passwordHash: challenge.passwordHash,
              emailVerified: true,
            },
            select: { id: true, name: true, email: true, role: true },
          });
      return { kind: "verified" as const, user };
    });

    if (outcome.kind === "incorrect") {
      throw new HttpError(400, "The verification code is incorrect.");
    }
    if (outcome.kind === "expired" || outcome.kind === "invalid") {
      throw new HttpError(400, "The verification code is invalid or expired.");
    }
    if (outcome.kind === "locked") {
      throw new HttpError(429, "Too many incorrect codes. Request a new verification code.");
    }
    if (outcome.kind === "already-verified") {
      throw new HttpError(409, "This school email already has an account. Sign in instead.");
    }
    if (outcome.kind === "inactive") {
      throw new HttpError(403, "This school account is inactive. Contact the school administrator.");
    }
    if (outcome.kind !== "verified") {
      throw new HttpError(400, "The verification code could not be used. Request a new code.");
    }

    await createLoginSession(prisma, outcome.user.id, config.nodeEnv === "production", res);
    res.status(201).json({ user: outcome.user });
  });

  router.post("/auth/login", async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const passwordMatches = await bcrypt.compare(
      body.password,
      user?.passwordHash ?? dummyPasswordHash,
    );
    if (!user || !user.isActive || !user.emailVerified || !user.passwordHash || !passwordMatches) {
      throw new HttpError(401, "Email or password is incorrect.");
    }

    await createLoginSession(prisma, user.id, config.nodeEnv === "production", res);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
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
        schoolEmailVerified: user.emailVerified,
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
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Invalid Stripe webhook request." });
      return;
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
    } catch {
      res.status(400).json({ error: "Invalid Stripe webhook signature." });
      return;
    }
    await applyStripeEvent(prisma, event);
    res.json({ received: true });
  });

  return router;
}
