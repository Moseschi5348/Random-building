import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PrismaClient, UserRole } from "@prisma/client";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { HttpError } from "./http";

type AuthenticatedUser = { id: string; role: UserRole };

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function requireAuth(prisma: PrismaClient, secret: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [scheme, token] = (req.header("authorization") ?? "").split(" ");
      if (scheme !== "Bearer" || !token) {
        throw new HttpError(401, "Authentication is required.");
      }

      const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
      if (typeof payload === "string" || typeof (payload as JwtPayload).sub !== "string") {
        throw new HttpError(401, "Invalid access token.");
      }

      const user = await prisma.user.findUnique({
        where: { id: (payload as JwtPayload).sub },
        select: { id: true, role: true, isActive: true },
      });
      if (!user || !user.isActive) {
        throw new HttpError(401, "The account is unavailable.");
      }

      req.user = { id: user.id, role: user.role };
      next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        next(new HttpError(401, "Invalid or expired access token."));
        return;
      }
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
