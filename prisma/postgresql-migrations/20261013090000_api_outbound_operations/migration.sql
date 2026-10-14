CREATE TABLE "ApiOutboundOperation" (
  "id" VARCHAR(36) PRIMARY KEY,
  "instanceId" VARCHAR(100) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "plannedWhatsappMessageId" VARCHAR(32) NOT NULL,
  "destinationJid" VARCHAR(100), "result" JSONB,
  "claimToken" VARCHAR(36), "leaseExpiresAt" TIMESTAMP(3),
  "transportStartedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" VARCHAR(80),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ApiOutbound_instance_state_idx" ON "ApiOutboundOperation" ("instanceId", "state");
CREATE UNIQUE INDEX "ApiOutbound_instance_native_key" ON "ApiOutboundOperation" ("instanceId", "plannedWhatsappMessageId");
