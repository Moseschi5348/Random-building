import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  MembershipStatus,
  RegistrationStatus,
  UserRole,
  type PrismaClient,
} from "@prisma/client";
import type Stripe from "stripe";
import { requireAuth, requireRole } from "./auth";
import type { AppConfig } from "./config";
import { HttpError, parseBody } from "./http";
import { applyStripeEvent, createCheckoutSession } from "./payments";
import { z } from "zod";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

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

function issueAccessToken(
  user: { id: string; role: UserRole },
  secret: string,
  expiresIn: string,
): string {
  return jwt.sign({ role: user.role }, secret, {
    subject: user.id,
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
  });
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
  const auth = requireAuth(prisma, config.jwtSecret);

  router.post("/auth/register", async (req, res) => {
    const body = parseBody(registerSchema, req.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.create({
      data: { name: body.name, email: body.email, passwordHash },
      select: { id: true, name: true, email: true, role: true, points: true },
    });
    res.status(201).json({
      user,
      accessToken: issueAccessToken(user, config.jwtSecret, config.jwtExpiresIn),
    });
  });

  router.post("/auth/login", async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const passwordMatches = await bcrypt.compare(
      body.password,
      user?.isActive ? user.passwordHash : dummyPasswordHash,
    );
    if (!user || !user.isActive || !passwordMatches) {
      throw new HttpError(401, "Email or password is incorrect.");
    }
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        points: user.points,
      },
      accessToken: issueAccessToken(user, config.jwtSecret, config.jwtExpiresIn),
    });
  });

  router.get("/me", auth, async (req, res) => {
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
      },
    });
    if (!user) {
      throw new HttpError(404, "User not found.");
    }
    res.json(user);
  });

  router.patch("/me/password", auth, async (req, res) => {
    const body = parseBody(
      z.object({
        currentPassword: z.string().min(1).max(128),
        newPassword: z.string().min(12).max(128),
      }),
      req.body,
    );
    if (body.currentPassword === body.newPassword) {
      throw new HttpError(400, "New password must be different from the current password.");
    }

    const user = await prisma.user.findUnique({
      where: { id: currentUserId(req) },
      select: { passwordHash: true },
    });
    if (!user) {
      throw new HttpError(404, "User not found.");
    }
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw new HttpError(401, "The current password is incorrect.");
    }

    await prisma.user.update({
      where: { id: currentUserId(req) },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 12) },
    });
    res.status(204).send();
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
