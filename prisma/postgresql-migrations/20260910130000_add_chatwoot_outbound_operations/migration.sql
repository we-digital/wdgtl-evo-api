-- CreateTable
CREATE TABLE "ChatwootOutboundOperation" (
    "id" TEXT NOT NULL,
    "operationKey" VARCHAR(64) NOT NULL,
    "messageSetHash" VARCHAR(64) NOT NULL,
    "instanceId" TEXT NOT NULL,
    "chatwootMessageId" INTEGER NOT NULL,
    "chatwootInboxId" INTEGER NOT NULL,
    "chatwootConversationId" INTEGER NOT NULL,
    "partIdentity" VARCHAR(64) NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "partCount" INTEGER NOT NULL,
    "plannedWhatsappMessageId" VARCHAR(32) NOT NULL,
    "whatsappMessageId" VARCHAR(100),
    "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "preparationAttempts" INTEGER NOT NULL DEFAULT 0,
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

-- CreateIndex
CREATE UNIQUE INDEX "Cwo_operation_key_key" ON "ChatwootOutboundOperation"("operationKey");

-- CreateIndex
CREATE INDEX "Cwo_state_next_idx" ON "ChatwootOutboundOperation"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "Cwo_instance_message_idx" ON "ChatwootOutboundOperation"("instanceId", "chatwootMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Cwo_instance_message_part_key" ON "ChatwootOutboundOperation"("instanceId", "chatwootMessageId", "partIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "Cwo_instance_message_index_key" ON "ChatwootOutboundOperation"("instanceId", "chatwootMessageId", "partIndex");

-- AddForeignKey
ALTER TABLE "ChatwootOutboundOperation" ADD CONSTRAINT "ChatwootOutboundOperation_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
