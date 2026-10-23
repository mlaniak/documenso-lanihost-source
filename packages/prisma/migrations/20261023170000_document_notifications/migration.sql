BEGIN;
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN "notificationSettings" JSONB;
ALTER TABLE "TeamGlobalSettings" ADD COLUMN "notificationSettings" JSONB;
CREATE TABLE "DocumentNotificationDelivery" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "envelopeId" TEXT NOT NULL REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "recipientId" INTEGER,
 "audience" TEXT NOT NULL,
 "channel" TEXT NOT NULL,
 "event" TEXT NOT NULL,
 "routeKey" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING',
 "attemptCount" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "claimedAt" TIMESTAMP(3),
 "acceptedAt" TIMESTAMP(3),
 "providerMessageId" TEXT,
 "lastError" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DocumentNotificationDelivery_status_nextAttemptAt_idx" ON "DocumentNotificationDelivery"("status", "nextAttemptAt");
CREATE INDEX "DocumentNotificationDelivery_envelopeId_createdAt_idx" ON "DocumentNotificationDelivery"("envelopeId", "createdAt");
COMMIT;
