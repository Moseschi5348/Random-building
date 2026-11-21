import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
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
      allowedHeaders: ["Content-Type", "Authorization", "Stripe-Signature"],
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
  app.use(
    "/api/auth",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );

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
