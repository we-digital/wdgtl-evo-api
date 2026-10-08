CREATE TABLE "ChatwootInboundDelivery" (
 "id" VARCHAR(64) PRIMARY KEY, "instanceId" TEXT NOT NULL, "instanceName" TEXT NOT NULL,
 "providerId" TEXT NOT NULL, "providerFingerprint" VARCHAR(64) NOT NULL,
 "accountId" INTEGER NOT NULL, "inboxId" INTEGER,
 "peer" VARCHAR(100) NOT NULL, "sourceId" VARCHAR(100) NOT NULL, "fromMe" BOOLEAN NOT NULL,
 "payload" JSONB NOT NULL, "payloadHash" VARCHAR(64) NOT NULL,
 "state" VARCHAR(32) NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "leaseOwner" VARCHAR(100), "leaseExpiresAt" TIMESTAMP(3), "lastErrorClass" VARCHAR(100),
 "result" JSONB, "confirmedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "Cwi_pending_idx" ON "ChatwootInboundDelivery"("state", "nextAttemptAt", "leaseExpiresAt");
