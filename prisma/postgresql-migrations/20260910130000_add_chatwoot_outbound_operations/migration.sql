CREATE TABLE "ChatwootOutboundOperation" (
    "id" TEXT NOT NULL,
    "operationKey" VARCHAR(64) NOT NULL,
    "instanceId" TEXT NOT NULL,
    "chatwootMessageId" INTEGER NOT NULL,
    "chatwootInboxId" INTEGER NOT NULL,
    "chatwootConversationId" INTEGER NOT NULL,
    "partIdentity" VARCHAR(64) NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "plannedWhatsappMessageId" VARCHAR(32) NOT NULL,
    "whatsappMessageId" VARCHAR(100),
    "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "sendAttempts" INTEGER NOT NULL DEFAULT 0,
    "callbackAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(100),
    "leaseExpiresAt" TIMESTAMP,
    "sendStartedAt" TIMESTAMP,
    "sentAt" TIMESTAMP,
    "completedAt" TIMESTAMP,
    "lastErrorClass" VARCHAR(100),
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "ChatwootOutboundOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatwootOutboundOperation_operationKey_key"
    ON "ChatwootOutboundOperation"("operationKey");
CREATE UNIQUE INDEX "ChatwootOutboundOperation_instanceId_chatwootMessageId_partIdentity_key"
    ON "ChatwootOutboundOperation"("instanceId", "chatwootMessageId", "partIdentity");
CREATE INDEX "ChatwootOutboundOperation_state_nextAttemptAt_idx"
    ON "ChatwootOutboundOperation"("state", "nextAttemptAt");
CREATE INDEX "ChatwootOutboundOperation_instanceId_chatwootMessageId_idx"
    ON "ChatwootOutboundOperation"("instanceId", "chatwootMessageId");

ALTER TABLE "ChatwootOutboundOperation"
    ADD CONSTRAINT "ChatwootOutboundOperation_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
