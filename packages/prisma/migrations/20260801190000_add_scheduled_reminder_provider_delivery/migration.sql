CREATE TYPE "ScheduledReminderProviderStatus" AS ENUM (
    'SUBMITTED',
    'DELAYED',
    'DELIVERED',
    'BOUNCED',
    'FAILED',
    'SUPPRESSED'
);

ALTER TABLE "ScheduledReminderDelivery"
ADD COLUMN "providerStatus" "ScheduledReminderProviderStatus",
ADD COLUMN "providerStatusAt" TIMESTAMP(3),
ADD COLUMN "providerMessageId" TEXT,
ADD COLUMN "providerEmailId" TEXT,
ADD COLUMN "providerFailureCode" TEXT,
ADD COLUMN "providerSubmittedAt" TIMESTAMP(3),
ADD COLUMN "providerDelayedAt" TIMESTAMP(3),
ADD COLUMN "providerDeliveredAt" TIMESTAMP(3),
ADD COLUMN "providerFailedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ScheduledReminderDelivery_providerMessageId_key"
ON "ScheduledReminderDelivery"("providerMessageId");

CREATE UNIQUE INDEX "ScheduledReminderDelivery_providerEmailId_key"
ON "ScheduledReminderDelivery"("providerEmailId");

CREATE TABLE "ScheduledReminderProviderEvent" (
    "id" TEXT NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "providerEmailId" VARCHAR(255),
    "messageId" VARCHAR(512) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryId" TEXT NOT NULL,

    CONSTRAINT "ScheduledReminderProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduledReminderProviderEvent_deliveryId_occurredAt_idx"
ON "ScheduledReminderProviderEvent"("deliveryId", "occurredAt");

CREATE INDEX "ScheduledReminderProviderEvent_providerEmailId_idx"
ON "ScheduledReminderProviderEvent"("providerEmailId");

CREATE INDEX "ScheduledReminderProviderEvent_messageId_idx"
ON "ScheduledReminderProviderEvent"("messageId");

ALTER TABLE "ScheduledReminderProviderEvent"
ADD CONSTRAINT "ScheduledReminderProviderEvent_deliveryId_fkey"
FOREIGN KEY ("deliveryId") REFERENCES "ScheduledReminderDelivery"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
