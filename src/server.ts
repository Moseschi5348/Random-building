import { PrismaClient } from "@prisma/client";
import express from "express";
import { createApp } from "./app-factory";
import { getConfig } from "./config";

const config = getConfig();
const prisma = new PrismaClient();
const app = createApp(prisma, config, express());

const server = app.listen(config.port, () => {
  console.log(`Club API listening on port ${config.port}`);
});

// Periodic session cleanup: delete expired sessions every 30 minutes
const SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const sessionCleanupTimer = setInterval(async () => {
  try {
    const deleted = await prisma.session.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    if (deleted.count > 0) {
      console.log(`Cleaned up ${deleted.count} expired session(s).`);
    }
  } catch (error) {
    console.error("Scheduled session cleanup failed.", error);
  }
}, SESSION_CLEANUP_INTERVAL_MS);
sessionCleanupTimer.unref();

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received; shutting down.`);
  clearInterval(sessionCleanupTimer);
  server.close(async (error) => {
    await prisma.$disconnect();
    if (error) {
      console.error("HTTP server shutdown failed.", error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
