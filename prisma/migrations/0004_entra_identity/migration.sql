ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

ALTER TABLE "User" ADD COLUMN "entraObjectId" TEXT;

CREATE UNIQUE INDEX "User_entraObjectId_key" ON "User"("entraObjectId");
