CREATE TYPE "ScheduledReminderDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');

CREATE TABLE "ScheduledReminderDelivery" (
    "id" TEXT NOT NULL,
    "status" "ScheduledReminderDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "envelopeId" TEXT NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "createdById" INTEGER,

    CONSTRAINT "ScheduledReminderDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduledReminderDelivery_status_nextAttemptAt_idx"
ON "ScheduledReminderDelivery"("status", "nextAttemptAt");

CREATE INDEX "ScheduledReminderDelivery_recipientId_createdAt_idx"
ON "ScheduledReminderDelivery"("recipientId", "createdAt");

CREATE INDEX "ScheduledReminderDelivery_envelopeId_createdAt_idx"
ON "ScheduledReminderDelivery"("envelopeId", "createdAt");

CREATE INDEX "ScheduledReminderDelivery_createdById_idx"
ON "ScheduledReminderDelivery"("createdById");

CREATE UNIQUE INDEX "ScheduledReminderDelivery_recipientId_active_key"
ON "ScheduledReminderDelivery"("recipientId")
WHERE "status" IN ('PENDING', 'PROCESSING');

ALTER TABLE "ScheduledReminderDelivery"
ADD CONSTRAINT "ScheduledReminderDelivery_envelopeId_fkey"
FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduledReminderDelivery"
ADD CONSTRAINT "ScheduledReminderDelivery_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduledReminderDelivery"
ADD CONSTRAINT "ScheduledReminderDelivery_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve any schedules created between the initial feature release and this
-- durable delivery-ledger migration.
INSERT INTO "ScheduledReminderDelivery" (
    "id",
    "status",
    "scheduledAt",
    "nextAttemptAt",
    "createdAt",
    "updatedAt",
    "envelopeId",
    "recipientId",
    "createdById"
)
SELECT
    'scheduled_reminder_' || recipient."id"::TEXT,
    'PENDING'::"ScheduledReminderDeliveryStatus",
    recipient."scheduledReminderAt",
    recipient."scheduledReminderAt",
    COALESCE(recipient."scheduledReminderCreatedAt", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP,
    recipient."envelopeId",
    recipient."id",
    recipient."scheduledReminderCreatedBy"
FROM "Recipient" AS recipient
WHERE recipient."scheduledReminderAt" IS NOT NULL;
