ALTER TABLE "ScheduledReminderDelivery"
ADD COLUMN "manualRetryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "retryable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "sequenceId" TEXT,
ADD COLUMN "sequencePosition" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "sequenceTotal" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "sequenceIntervalDays" INTEGER,
ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Etc/UTC';

CREATE INDEX "ScheduledReminderDelivery_sequenceId_sequencePosition_idx"
ON "ScheduledReminderDelivery"("sequenceId", "sequencePosition");

ALTER TABLE "ScheduledReminderDelivery"
ADD CONSTRAINT "ScheduledReminderDelivery_sequence_bounds_check"
CHECK (
  "sequencePosition" >= 1
  AND "sequenceTotal" BETWEEN 1 AND 5
  AND "sequencePosition" <= "sequenceTotal"
  AND ("sequenceIntervalDays" IS NULL OR "sequenceIntervalDays" BETWEEN 1 AND 30)
);
