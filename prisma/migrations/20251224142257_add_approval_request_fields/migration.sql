-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN "discordChannelId" TEXT;
ALTER TABLE "ApprovalRequest" ADD COLUMN "discordMessageId" TEXT;
ALTER TABLE "ApprovalRequest" ADD COLUMN "resolvedAt" DATETIME;
ALTER TABLE "ApprovalRequest" ADD COLUMN "resolvedBy" TEXT;
