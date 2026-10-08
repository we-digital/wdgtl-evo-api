CREATE TABLE `ChatwootInboundDelivery` (
 `id` VARCHAR(64) NOT NULL, `instanceId` VARCHAR(191) NOT NULL, `instanceName` VARCHAR(191) NOT NULL,
 `providerId` VARCHAR(191) NOT NULL, `providerFingerprint` VARCHAR(64) NOT NULL,
 `accountId` INTEGER NOT NULL, `inboxId` INTEGER NULL,
 `peer` VARCHAR(100) NOT NULL, `sourceId` VARCHAR(100) NOT NULL, `fromMe` BOOLEAN NOT NULL,
 `payload` JSON NOT NULL, `payloadHash` VARCHAR(64) NOT NULL,
 `state` VARCHAR(32) NOT NULL DEFAULT 'pending', `attempts` INTEGER NOT NULL DEFAULT 0,
 `nextAttemptAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 `leaseOwner` VARCHAR(100) NULL, `leaseExpiresAt` TIMESTAMP(3) NULL, `lastErrorClass` VARCHAR(100) NULL,
 `result` JSON NULL, `confirmedAt` TIMESTAMP(3) NULL,
 `createdAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` TIMESTAMP(3) NOT NULL,
 PRIMARY KEY (`id`), INDEX `Cwi_pending_idx` (`state`, `nextAttemptAt`, `leaseExpiresAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
