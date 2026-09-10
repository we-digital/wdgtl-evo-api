# Durable Chatwoot outbound delivery

## Purpose

The API-inbox webhook can finish a WhatsApp send after Chatwoot's synchronous
HTTP timeout. The durable outbound path accepts a validated webhook only after
recording every text or attachment part, then sends those operations outside
the request. It prevents a delayed successful send from being reported as a
transport failure and prevents duplicate webhook delivery from creating
duplicate WhatsApp messages.

## Safety contract

- Enable with `CHATWOOT_OUTBOUND_ASYNC_ENABLED=true`. The default is `false`.
- The route binding, instance, inbox, conversation and current Chatwoot message
  are validated before durable enqueue. A malformed request is not accepted.
- The unique key is a SHA-256 of EVO instance ID, Chatwoot message ID and the
  text/attachment part identity. The webhook returns HTTP 202 only after all
  parts commit in one database transaction.
- Each part receives a deterministic planned WhatsApp message ID. Baileys gets
  that ID through its supported `messageId` send option.
- Media resolution, recipient validation, quoting and other preparation happen
  in `preparing`. A failure there is proven pre-transport and may retry with
  bounded backoff.
- The operation becomes `sending` in the database immediately before the
  Baileys transport call. A failure or restart after that transition becomes
  `ambiguous` and never causes a blind resend.
- Ambiguous operations reconcile only against the exact planned WhatsApp ID in
  the EVO `Message` table. When found, the worker continues with the Chatwoot
  callback; when absent, it remains ambiguous for operator visibility.
- Callback retries update the existing Chatwoot message by API PATCH with
  `status=sent`, the raw WhatsApp message ID as `source_id`, and a cleared stale
  `external_error`. They never invoke WhatsApp again.
- Logs contain only state/error classes and aggregate counts. Do not log the
  payload, phone/JID, body, media URL, route binding or customer identifiers.

Backoff begins at five seconds and is capped at five minutes. Claims use a
ten-minute database lease. Expired `preparing` leases return to `pending`;
expired `sending` leases become `ambiguous`; callback leases are reclaimed.
The deployment contract uses a single application process, while the
database claim still prevents concurrent workers from taking the same row.

## Additive schema and deployment

Apply the provider-specific migration before enabling the flag. It adds only
`ChatwootOutboundOperation`, its indexes and an `Instance` foreign key. No
existing table or row is rewritten. PostgreSQL, PgBouncer schema generation
and MySQL are kept equivalent.

Staging sequence:

1. Deploy the compatible Chatwoot PATCH contract.
2. Deploy this EVO image with the flag disabled and apply the additive
   migration.
3. Confirm one EVO process, all required instances connected and the queue
   aggregate empty.
4. Enable the flag for staging and restart the application once.
5. Exercise text, media, multiple attachments, duplicate webhook, delayed
   callback, connection loss before transport and process restart after send.
6. Confirm every accepted operation reaches `completed`, or a deliberately
   ambiguous operation stays visible without a second WhatsApp send.

Production promotion uses the exact reviewed source change and immutable image
digest only after the staging evidence is accepted.

## Privacy-safe observation

PostgreSQL state/depth query (returns no customer identifiers):

```sql
SELECT state, COUNT(*) AS depth, MIN("createdAt") AS oldest
FROM "ChatwootOutboundOperation"
WHERE state <> 'completed'
GROUP BY state
ORDER BY state;
```

MySQL equivalent:

```sql
SELECT state, COUNT(*) AS depth, MIN(createdAt) AS oldest
FROM ChatwootOutboundOperation
WHERE state <> 'completed'
GROUP BY state
ORDER BY state;
```

For rollout, record only state counts, oldest age, source SHA, image digest,
worker count and HTTP status. Never copy operation payloads or raw IDs into
logs, tickets or Slack.

## Rollback

1. Set `CHATWOOT_OUTBOUND_ASYNC_ENABLED=false` and deploy the prior immutable
   EVO image.
2. Leave the additive table in place. Do not delete or reset operations.
3. Confirm the previous synchronous path and instance connectivity.
4. Before any later re-enable, inspect aggregate states. An `ambiguous` row
   requires exact-WAID reconciliation; it must never be changed to `pending`.

Rolling back Chatwoot and EVO are independent image operations, but Chatwoot
must retain the compatible optional `source_id` PATCH field while queued EVO
callbacks remain.
