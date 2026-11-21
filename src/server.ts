import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { createApp } from "./app-factory";
import { getConfig } from "./config";

const config = getConfig();
const prisma = new PrismaClient();
const stripe = new Stripe(config.stripeSecretKey);
const app = createApp(prisma, stripe, config);

const server = app.listen(config.port, () => {
  console.log(`DIS API listening on port ${config.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received; shutting down.`);
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
