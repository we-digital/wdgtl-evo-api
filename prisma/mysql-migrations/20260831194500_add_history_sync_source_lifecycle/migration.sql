ALTER TABLE `Setting`
ADD COLUMN `historySyncSourceKey` VARCHAR(64) NULL,
ADD COLUMN `historySyncBootstrapCompletedAt` TIMESTAMP NULL;

-- Rollout safety: every source that predates this registry is established.
-- A truly new Setting row keeps the nullable default and requests its one-shot bootstrap.
UPDATE `Setting`
SET `historySyncBootstrapCompletedAt` = CURRENT_TIMESTAMP
WHERE `historySyncBootstrapCompletedAt` IS NULL;
