BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "MessageUpdate" ADD COLUMN "providerErrorCode" VARCHAR(6);
COMMIT;
