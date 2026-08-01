ALTER TABLE "Recipient"
ADD COLUMN "scheduledReminderAt" TIMESTAMP(3),
ADD COLUMN "scheduledReminderCreatedAt" TIMESTAMP(3),
ADD COLUMN "scheduledReminderCreatedBy" INTEGER;

CREATE INDEX "Recipient_scheduledReminderAt_idx" ON "Recipient"("scheduledReminderAt");
