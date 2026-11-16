-- we:Digital (owner, 2026-11-16): WhatsApp ids of messages sent through this API (not by Chatwoot, not from a
-- linked device). A fromMe echo whose id is here is origin "api"; otherwise "native".
CREATE TABLE "ApiSentMessage" (
  "instanceId" VARCHAR(100) NOT NULL,
  "messageId" VARCHAR(100) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiSentMessage_pkey" PRIMARY KEY ("instanceId", "messageId")
);
