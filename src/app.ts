import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import type { AppConfig } from "./config";
import { errorHandler, notFoundHandler } from "./http";
import { createApiRouter } from "./routes";

export function createApp(prisma: PrismaClient, stripe: Stripe, config: AppConfig) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(
    cors({
      origin: config.corsOrigins,
      methods: ["GET", "POST", "PATCH"],
      allowedHeaders: ["Content-Type", "Stripe-Signature", "X-CSRF-Token"],
    }),
  );
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 200,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skip: (req) => req.path === "/api/webhooks/stripe",
    }),
  );
  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.use("/api/auth/login", authRateLimit);
  app.use("/api/auth/register", authRateLimit);
  app.use("/api/auth/verify-email", authRateLimit);
  app.use("/api/auth/resend-verification", authRateLimit);

  const frontendFiles: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/home.html": "home.html",
    "/login.html": "login.html",
    "/register.html": "register.html",
    "/clubs.html": "clubs.html",
    "/activities.html": "activities.html",
    "/rewards.html": "rewards.html",
    "/community.html": "community.html",
    "/style.css": "style.css",
    "/pages.css": "pages.css",
    "/script.js": "script.js",
    "/community.js": "community.js",
    "/auth.js": "auth.js",
    "/theme.js": "theme.js",
    "/assets/fonts/Roboto-Regular.ttf": "assets/fonts/Roboto-Regular.ttf",
    "/assets/fonts/Roboto-Medium.ttf": "assets/fonts/Roboto-Medium.ttf",
    "/assets/fonts/Roboto-SemiBold.ttf": "assets/fonts/Roboto-SemiBold.ttf",
    "/assets/fonts/Roboto-Bold.ttf": "assets/fonts/Roboto-Bold.ttf",
  };
  app.get(Object.keys(frontendFiles), (req, res, next) => {
    const file = frontendFiles[req.path];
    if (!file) {
      next();
      return;
    }
    res.sendFile(resolve(process.cwd(), "public", file), (error) => {
      if (error) next(error);
    });
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use(
    "/api/webhooks/stripe",
    express.raw({ type: "application/json", limit: "100kb" }),
  );
  app.use("/api", express.json({ limit: "100kb" }));
  app.use("/api", createApiRouter(prisma, stripe, config));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
