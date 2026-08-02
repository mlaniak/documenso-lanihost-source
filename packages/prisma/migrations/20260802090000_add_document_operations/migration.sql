-- Add team-scoped operational preferences without changing Documenso's core settings contract.
ALTER TABLE "TeamGlobalSettings" ADD COLUMN "operationsSettings" JSONB;

CREATE TYPE "DocumentAutomationType" AS ENUM ('COMPLETION_ARCHIVE', 'SIGNING_LINK_SMS');
CREATE TYPE "DocumentAutomationStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

CREATE TABLE "DocumentAutomationRun" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" "DocumentAutomationType" NOT NULL,
    "status" "DocumentAutomationStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "providerId" TEXT,
    "error" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "envelopeId" TEXT NOT NULL,

    CONSTRAINT "DocumentAutomationRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentAutomationRun_idempotencyKey_key" ON "DocumentAutomationRun"("idempotencyKey");
CREATE INDEX "DocumentAutomationRun_envelopeId_type_idx" ON "DocumentAutomationRun"("envelopeId", "type");
CREATE INDEX "DocumentAutomationRun_status_createdAt_idx" ON "DocumentAutomationRun"("status", "createdAt");

ALTER TABLE "DocumentAutomationRun"
ADD CONSTRAINT "DocumentAutomationRun_envelopeId_fkey"
FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
