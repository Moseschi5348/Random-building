CREATE TYPE "CommunityRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');
CREATE TYPE "CommunityGameKey" AS ENUM ('CHESS', 'QUIZ', 'WORDS');
CREATE TYPE "CommunityMeetupKey" AS ENUM ('CHESS', 'ART');

ALTER TABLE "User"
ADD COLUMN "communityVisible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "communityInterests" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "CommunityConnection" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "status" "CommunityRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunityConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommunityConnection_requesterId_recipientId_key"
ON "CommunityConnection"("requesterId", "recipientId");
CREATE INDEX "CommunityConnection_recipientId_status_idx"
ON "CommunityConnection"("recipientId", "status");
ALTER TABLE "CommunityConnection"
ADD CONSTRAINT "CommunityConnection_requesterId_fkey"
FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityConnection"
ADD CONSTRAINT "CommunityConnection_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CommunityGameInvite" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "game" "CommunityGameKey" NOT NULL,
    "status" "CommunityRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunityGameInvite_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommunityGameInvite_senderId_recipientId_status_idx"
ON "CommunityGameInvite"("senderId", "recipientId", "status");
CREATE INDEX "CommunityGameInvite_recipientId_status_idx"
ON "CommunityGameInvite"("recipientId", "status");
ALTER TABLE "CommunityGameInvite"
ADD CONSTRAINT "CommunityGameInvite_senderId_fkey"
FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityGameInvite"
ADD CONSTRAINT "CommunityGameInvite_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CommunityMeetupInterest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "meetup" "CommunityMeetupKey" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityMeetupInterest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommunityMeetupInterest_userId_meetup_key"
ON "CommunityMeetupInterest"("userId", "meetup");
CREATE INDEX "CommunityMeetupInterest_meetup_idx"
ON "CommunityMeetupInterest"("meetup");
ALTER TABLE "CommunityMeetupInterest"
ADD CONSTRAINT "CommunityMeetupInterest_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
