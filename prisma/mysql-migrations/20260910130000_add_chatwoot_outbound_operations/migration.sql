CREATE TABLE `ChatwootOutboundOperation` (
    `id` VARCHAR(191) NOT NULL,
    `operationKey` VARCHAR(64) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `chatwootMessageId` INTEGER NOT NULL,
    `chatwootInboxId` INTEGER NOT NULL,
    `chatwootConversationId` INTEGER NOT NULL,
    `partIdentity` VARCHAR(64) NOT NULL,
    `partIndex` INTEGER NOT NULL,
    `plannedWhatsappMessageId` VARCHAR(32) NOT NULL,
    `whatsappMessageId` VARCHAR(100) NULL,
    `state` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `payload` JSON NOT NULL,
    `result` JSON NULL,
    `sendAttempts` INTEGER NOT NULL DEFAULT 0,
    `callbackAttempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `leaseOwner` VARCHAR(100) NULL,
    `leaseExpiresAt` TIMESTAMP NULL,
    `sendStartedAt` TIMESTAMP NULL,
    `sentAt` TIMESTAMP NULL,
    `completedAt` TIMESTAMP NULL,
    `lastErrorClass` VARCHAR(100) NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL,

    UNIQUE INDEX `ChatwootOutboundOperation_operationKey_key`(`operationKey`),
    UNIQUE INDEX `ChatwootOutboundOperation_instanceId_chatwootMessageId_partIdentity_key`
        (`instanceId`, `chatwootMessageId`, `partIdentity`),
    INDEX `ChatwootOutboundOperation_state_nextAttemptAt_idx`(`state`, `nextAttemptAt`),
    INDEX `ChatwootOutboundOperation_instanceId_chatwootMessageId_idx`(`instanceId`, `chatwootMessageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ChatwootOutboundOperation`
    ADD CONSTRAINT `ChatwootOutboundOperation_instanceId_fkey`
    FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
