import "dotenv/config";
import { PrismaClient, QuizStatus, UserRole } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() || "admin@example.com";

  console.log(`Seeding admin account: ${email}...`);
  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: UserRole.ADMIN, isActive: true },
    create: {
      name: "Club Administrator",
      email,
      role: UserRole.ADMIN,
      emailVerified: true,
    },
  });

  console.log("Seeding initial departments...");
  const initialDepartments = [
    {
      name: "Design",
      icon: "🎨",
      description: "UI/UX, visual design, graphic arts, brand identity, and design systems.",
    },
    {
      name: "Development",
      icon: "💻",
      description: "Web, mobile, cloud apps, software engineering, and open-source projects.",
    },
    {
      name: "Cybersecurity",
      icon: "🛡️",
      description: "Ethical hacking, network defense, security audits, and CTF competitions.",
    },
    {
      name: "Media",
      icon: "📸",
      description: "Content creation, video editing, social channels, photography, and storytelling.",
    },
  ];

  for (const dept of initialDepartments) {
    await prisma.department.upsert({
      where: { name: dept.name },
      update: { description: dept.description, icon: dept.icon },
      create: dept,
    });
  }

  console.log("Seeding initial quiz questions...");
  const quizTitle = "Club Kickoff Trivia";
  let quiz = await prisma.quiz.findFirst({
    where: { title: quizTitle },
  });

  if (!quiz) {
    quiz = await prisma.quiz.create({
      data: {
        title: quizTitle,
        description: "Test your knowledge across Design, Dev, Security, and Media! Earn club points.",
        status: QuizStatus.LIVE,
        joinCode: "TRIVIA",
        createdById: admin.id,
      },
    });

    const questions = [
      {
        prompt: "In Git, what command creates and switches to a new branch in one step?",
        timeLimitSeconds: 30,
        options: [
          { text: "git checkout -b <branch>", isCorrect: true },
          { text: "git branch --switch <branch>", isCorrect: false },
          { text: "git make-branch <branch>", isCorrect: false },
          { text: "git new <branch>", isCorrect: false },
        ],
      },
      {
        prompt: "Which contrast ratio is the WCAG AA minimum standard for normal body text?",
        timeLimitSeconds: 30,
        options: [
          { text: "4.5:1", isCorrect: true },
          { text: "2.1:1", isCorrect: false },
          { text: "7.0:1", isCorrect: false },
          { text: "3.0:1", isCorrect: false },
        ],
      },
      {
        prompt: "What security attack tricks a web browser into executing unwanted actions in a trusted session?",
        timeLimitSeconds: 30,
        options: [
          { text: "CSRF (Cross-Site Request Forgery)", isCorrect: true },
          { text: "SQL Injection", isCorrect: false },
          { text: "DDoS", isCorrect: false },
          { text: "Buffer Overflow", isCorrect: false },
        ],
      },
      {
        prompt: "In digital video editing, what standard frame rate is commonly used for cinematic motion blur?",
        timeLimitSeconds: 30,
        options: [
          { text: "24 fps", isCorrect: true },
          { text: "60 fps", isCorrect: false },
          { text: "12 fps", isCorrect: false },
          { text: "120 fps", isCorrect: false },
        ],
      },
    ];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await prisma.quizQuestion.create({
        data: {
          quizId: quiz.id,
          position: i + 1,
          prompt: q.prompt,
          timeLimitSeconds: q.timeLimitSeconds,
          options: {
            create: q.options,
          },
        },
      });
    }
  }

  console.log("Seeding completed successfully.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
