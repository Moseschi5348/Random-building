import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PrismaClient, UserRole } from "@prisma/client";
import { HttpError } from "./http";

export const SESSION_COOKIE_NAME = "dis_session";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

type AuthenticatedUser = {
  id: string;
  role: UserRole;
  emailVerified: boolean;
  sessionId?: string;
  csrfToken?: string;
};

export type AppPermission = "student-life:read" | "community:read";

const rolePermissions: Record<UserRole, AppPermission[]> = {
  MEMBER: ["student-life:read", "community:read"],
  DEPARTMENT_HEAD: ["student-life:read", "community:read"],
  ADMIN: ["student-life:read", "community:read"],
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionCredentials(): {
  token: string;
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
} {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashSessionToken(token),
    csrfToken: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  };
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.append(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`,
  );
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.append(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`,
  );
}

export function readCookie(req: Request, name: string): string | undefined {
  const entry = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry?.slice(name.length + 1);
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function csrfMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !/^[a-f0-9]{64}$/.test(provided) || provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function requireAuth(prisma: PrismaClient): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = readCookie(req, SESSION_COOKIE_NAME);
      if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        throw new HttpError(401, "Authentication is required.");
      }

      const session = await prisma.session.findUnique({
        where: { tokenHash: hashSessionToken(token) },
        include: { user: { select: { id: true, role: true, isActive: true, emailVerified: true } } },
      });
      if (!session || session.expiresAt <= new Date()) {
        if (session) await prisma.session.deleteMany({ where: { id: session.id } });
        throw new HttpError(401, "The session is invalid or expired.");
      }
      if (!session.user.isActive) {
        await prisma.session.deleteMany({ where: { id: session.id } });
        throw new HttpError(401, "The account is unavailable.");
      }
      if (!isSafeMethod(req.method) && !csrfMatches(req.get("x-csrf-token"), session.csrfToken)) {
        throw new HttpError(403, "A valid CSRF token is required.");
      }
      req.user = {
        id: session.user.id,
        role: session.user.role,
        emailVerified: session.user.emailVerified,
        sessionId: session.id,
        csrfToken: session.csrfToken,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new HttpError(403, "You do not have permission to perform this action."));
      return;
    }
    next();
  };
}

export function requirePermission(permission: AppPermission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !rolePermissions[req.user.role].includes(permission)) {
      next(new HttpError(403, "You do not have permission to access this resource."));
      return;
    }
    if (permission === "community:read" && !req.user.emailVerified) {
      next(new HttpError(403, "A verified Google account is required to access the student community."));
      return;
    }
    next();
  };
}

export function permissionsForRole(role: UserRole): AppPermission[] {
  return [...rolePermissions[role]];
}
