ALTER TABLE `Chatwoot`
ADD COLUMN `webhookSecret` VARCHAR(255) NULL,
ADD COLUMN `webhookPreviousSecret` VARCHAR(255) NULL,
ADD COLUMN `webhookPreviousSecretValidUntil` TIMESTAMP NULL;

ALTER TABLE `ChatwootOutboundOperation`
ADD COLUMN `webhookDeliveryId` VARCHAR(100) NULL,
ADD COLUMN `laneKey` VARCHAR(64) NOT NULL DEFAULT '',
ADD COLUMN `laneSequence` BIGINT NOT NULL DEFAULT 0,
ADD COLUMN `webhookReceivedAt` TIMESTAMP NULL,
ADD COLUMN `messageCreatedAt` TIMESTAMP NULL,
ADD COLUMN `claimedAt` TIMESTAMP NULL,
ADD COLUMN `validatedAt` TIMESTAMP NULL,
ADD COLUMN `callbackStartedAt` TIMESTAMP NULL,
ADD COLUMN `transportOutcomeUnresolved` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `ChatwootOutboundOperation` ADD COLUMN `callbackContext` JSON NULL;

CREATE TABLE `ChatwootOutboundLane` (
  `laneKey` VARCHAR(64) NOT NULL,
  `nextSequence` BIGINT NOT NULL DEFAULT 0,
  `updatedAt` TIMESTAMP NOT NULL,
  PRIMARY KEY (`laneKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ChatwootOutboundAdmissionGuard` (
  `id` INTEGER NOT NULL,
  `version` BIGINT NOT NULL DEFAULT 0,
  `updatedAt` TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ChatwootOutboundWebhookDelivery` (
  `deliveryId` VARCHAR(100) NOT NULL,
  `instanceId` VARCHAR(191) NOT NULL,
  `chatwootMessageId` INTEGER NOT NULL,
  `messageSetHash` VARCHAR(64) NOT NULL,
  `receivedAt` TIMESTAMP NOT NULL,
  PRIMARY KEY (`deliveryId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `Cwo_delivery_part_key` ON `ChatwootOutboundOperation`(`webhookDeliveryId`, `partIndex`);
CREATE INDEX `Cwo_lane_order_idx` ON `ChatwootOutboundOperation`(`laneKey`, `laneSequence`, `partIndex`);
CREATE INDEX `Cwo_webhook_delivery_message_idx` ON `ChatwootOutboundWebhookDelivery`(`instanceId`, `chatwootMessageId`);
