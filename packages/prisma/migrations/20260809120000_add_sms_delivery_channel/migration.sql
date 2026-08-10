-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "ScheduledReminderDeliveryKind" AS ENUM ('SIGNING_REQUEST', 'REMINDER', 'COMPLETION');

-- CreateEnum
CREATE TYPE "SmsOptOutReason" AS ENUM ('STOP', 'MANUAL', 'PROVIDER_PERMANENT');

-- AlterTable
ALTER TABLE "DocumentMeta" ADD COLUMN     "smsEnabled" BOOLEAN;

-- AlterTable
ALTER TABLE "Recipient" ADD COLUMN     "phone" VARCHAR(20);

-- AlterTable
ALTER TABLE "ScheduledReminderDelivery" ADD COLUMN     "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
ADD COLUMN     "kind" "ScheduledReminderDeliveryKind" NOT NULL DEFAULT 'REMINDER';

-- AlterTable
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN     "smsSettings" JSONB;

-- AlterTable
ALTER TABLE "TeamGlobalSettings" ADD COLUMN     "smsSettings" JSONB;

-- CreateTable
CREATE TABLE "SmsOptOut" (
    "id" TEXT NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "teamId" INTEGER NOT NULL,
    "reason" "SmsOptOutReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsOptOut_teamId_idx" ON "SmsOptOut"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SmsOptOut_phone_teamId_key" ON "SmsOptOut"("phone", "teamId");

-- AddForeignKey
ALTER TABLE "SmsOptOut" ADD CONSTRAINT "SmsOptOut_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

