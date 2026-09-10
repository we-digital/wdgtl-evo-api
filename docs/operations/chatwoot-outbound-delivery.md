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
- Only an exact top-level `message_created` outgoing payload is eligible.
  Conversation-history messages and deletion events never enter this queue;
  the existing deletion handler remains synchronous. Every attachment needs a
  stable numeric Chatwoot attachment ID. Parts are ordered by that ID, so
  webhook array order cannot change their identities.
- The full origin (provider ID/base URL, account, inbox, conversation, message
  and contact-inbox source) and the physical EVO receiver/instance binding are
  captured at enqueue and revalidated from the live provider at preparation,
  immediately before transport, and before callback. A mismatch quarantines
  the complete message and never sends or retries it.
- The unique operation key covers the EVO instance, exact message-set hash and
  stable part identity. A database uniqueness constraint freezes one exact
  part set per `instance + Chatwoot message`; a replay with changed content,
  attachments or origin fails closed. HTTP 202 is returned only after the
  whole frozen set commits in one transaction.
- Each part receives a deterministic planned WhatsApp message ID. Baileys gets
  that ID through its supported `messageId` send option.
- Media resolution, recipient validation, quoting and other preparation happen
  in `preparing`. A failure there is proven pre-transport and may retry with
  bounded backoff. Six failed preparation attempts are terminal and trigger an
  exact message-level `failed` callback; they never invoke WhatsApp transport.
- The operation becomes `sending` in the database immediately before the
  Baileys transport call. A failure or restart after that transition becomes
  `ambiguous` and never causes a blind resend.
- Ambiguous operations reconcile only against the exact planned WhatsApp ID in
  the EVO `Message` table. When found, the worker continues with the Chatwoot
  callback; when absent, it remains ambiguous for operator visibility.
- Multipart delivery has exactly one message-level callback after every frozen
  part has an exact WAID. Chatwoot's single `source_id` receives the primary
  WAID (part index 0 after stable attachment-ID ordering); the other per-part
  WAIDs remain in `ChatwootOutboundOperation` for reconciliation and audit.
- Success callback retries PATCH the existing Chatwoot message with
  `status=sent`, the raw primary WAID as `source_id`, and `external_error=null`.
  EVO accepts the callback only when the response contains the exact message
  `id`, exact `source_id`, and status `sent`, `delivered`, or `read`. A terminal
  failure callback is accepted only for the exact message ID and `failed`
  status. Unacknowledged callbacks retry Chatwoot only and never send WhatsApp.
- With `CHATWOOT_OUTBOUND_ASYNC_ENABLED=false`, the legacy synchronous path and
  its source-ID update contract are unchanged.
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
7. Verify Chatwoot PATCH responses have this minimum shape for success:
   `{ id: <exact message id>, status: sent|delivered|read, source_id: <primary raw WAID> }`;
   failure acknowledgement is `{ id: <exact message id>, status: failed }`.

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

Do not disable async ingress while accepted work is still active: that would
strand durable operations when the old image starts serving synchronously.

1. Keep `CHATWOOT_OUTBOUND_ASYNC_ENABLED=true`, set
   `CHATWOOT_OUTBOUND_ASYNC_DRAIN_ONLY=true`, and restart the current reviewed
   image. New eligible webhooks receive 503 and therefore are not accepted;
   the worker continues draining already committed operations.
2. Observe aggregate states until no rows remain in `pending`, `preparing`,
   `sending`, `callback_pending`, or `failure_callback_pending`.
3. Reconcile every `ambiguous` row only by its exact planned WAID. Investigate
   `quarantined` rows against the captured origin/binding. Neither state may be
   reset to `pending`, deleted, or blindly resent.
4. Only after all accepted work is terminal, set
   `CHATWOOT_OUTBOUND_ASYNC_ENABLED=false` and deploy the prior immutable EVO
   image. Leave the additive table and its rows in place.
5. Confirm the legacy synchronous source-ID contract and instance connectivity.

If the current worker cannot drain safely, stop the rollback and repair or
reconcile it under the current image. Deploying the legacy image is not a queue
recovery mechanism.

Rolling back Chatwoot and EVO are independent image operations, but Chatwoot
must retain the compatible optional `source_id` PATCH field while queued EVO
callbacks remain.
