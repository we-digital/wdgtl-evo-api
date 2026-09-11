ALTER TABLE "Chatwoot"
ADD COLUMN "webhookSecret" VARCHAR(255),
ADD COLUMN "webhookPreviousSecret" VARCHAR(255),
ADD COLUMN "webhookPreviousSecretValidUntil" TIMESTAMP;

ALTER TABLE "ChatwootOutboundOperation"
ADD COLUMN "webhookDeliveryId" VARCHAR(100),
ADD COLUMN "laneKey" VARCHAR(64) NOT NULL DEFAULT '',
ADD COLUMN "laneSequence" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "webhookReceivedAt" TIMESTAMP,
ADD COLUMN "messageCreatedAt" TIMESTAMP,
ADD COLUMN "claimedAt" TIMESTAMP,
ADD COLUMN "validatedAt" TIMESTAMP,
ADD COLUMN "callbackStartedAt" TIMESTAMP,
ADD COLUMN "transportOutcomeUnresolved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatwootOutboundOperation" ADD COLUMN "callbackContext" JSONB;

UPDATE "ChatwootOutboundOperation"
SET "transportOutcomeUnresolved" = true
WHERE "whatsappMessageId" IS NULL
  AND (
    "state" IN ('sending', 'ambiguous')
    OR (
      "state" = 'quarantined'
      AND ("sendAttempts" > 0 OR "sendStartedAt" IS NOT NULL)
    )
  );

CREATE TABLE "ChatwootOutboundLane" (
  "laneKey" VARCHAR(64) NOT NULL,
  "nextSequence" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP NOT NULL,
  CONSTRAINT "ChatwootOutboundLane_pkey" PRIMARY KEY ("laneKey")
);

CREATE TABLE "ChatwootOutboundAdmissionGuard" (
  "id" INTEGER NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP NOT NULL,
  CONSTRAINT "ChatwootOutboundAdmissionGuard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatwootOutboundWebhookDelivery" (
  "deliveryId" VARCHAR(100) NOT NULL,
  "instanceId" TEXT NOT NULL,
  "chatwootMessageId" INTEGER NOT NULL,
  "messageSetHash" VARCHAR(64) NOT NULL,
  "receivedAt" TIMESTAMP NOT NULL,
  CONSTRAINT "ChatwootOutboundWebhookDelivery_pkey" PRIMARY KEY ("deliveryId")
);

CREATE UNIQUE INDEX "Cwo_delivery_part_key" ON "ChatwootOutboundOperation"("webhookDeliveryId", "partIndex");
CREATE INDEX "Cwo_lane_order_idx" ON "ChatwootOutboundOperation"("laneKey", "laneSequence", "partIndex");
CREATE INDEX "Cwo_webhook_delivery_message_idx" ON "ChatwootOutboundWebhookDelivery"("instanceId", "chatwootMessageId");
