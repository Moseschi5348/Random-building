import "dotenv/config";
import { PrismaClient, UserRole } from "@prisma/client";
import { isSchoolEmail } from "../src/otp";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || !isSchoolEmail(email)) {
    throw new Error("Set ADMIN_EMAIL to the administrator's @nutm.edu.ng school address.");
  }

  await prisma.user.upsert({
    where: { email },
    update: { role: UserRole.ADMIN, isActive: true },
    create: {
      name: "DIS Administrator",
      email,
      role: UserRole.ADMIN,
      passwordHash: null,
      emailVerified: false,
    },
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
