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
  Conversation-history messages never enter this queue. A deletion for a
  retained message atomically moves its complete frozen set to
  `delete_pending`, which prevents later transport and lets the worker delete
  every confirmed WhatsApp part before its local mapping is removed. Every attachment needs a
  stable numeric Chatwoot attachment ID. Parts are ordered by that ID, so
  webhook array order cannot change their identities.
- The full origin (provider ID/base URL, account, inbox ID/name, conversation, message
  and contact-inbox source) and the physical EVO receiver/instance binding are
  captured at enqueue and revalidated from the authoritative enabled provider
  row plus the live Chatwoot inbox, route metadata, conversation, current
  destination and message at preparation, immediately before transport, and
  before callback. Reassignment, rename, deletion, or any other mismatch
  quarantines the complete message and never sends or retries it.
- Validation reads one exact message through the bounded inbox-scoped endpoint
  `GET /accounts/:account/inboxes/:inbox/conversations/:conversation/messages/:message`.
  EVO unwraps production `{ meta, payload }` responses, accepts Chatwoot's
  numeric outgoing enum (`message_type=1`) and compatible
  `message_type_name=outgoing`, and never substitutes a latest-message list.
- The unique operation key covers the EVO instance, exact message-set hash and
  stable part identity. A database uniqueness constraint freezes one exact
  part set per `instance + Chatwoot message`; a replay with changed content,
  attachments or origin atomically quarantines every retained part and fails
  closed. HTTP 202 is returned only after the
  whole frozen set commits in one transaction.
- Each part receives a deterministic planned WhatsApp message ID. Baileys gets
  that ID through its supported `messageId` send option.
- Media resolution, recipient validation, quoting and other preparation happen
  in `preparing`. A failure there is proven pre-transport and may retry with
  bounded backoff. Six failed preparation attempts are terminal and trigger an
  exact message-level `failed` callback; they never invoke WhatsApp transport.
- Live validation, readiness, media preparation/send and Chatwoot callbacks
  have cancellable time budgets. Timeout before transport consumes a bounded
  preparation attempt; timeout after the durable `sending` transition is
  ambiguous and can only reconcile by exact planned WAID.
- The operation becomes `sending` in the database immediately before the
  Baileys transport call. A failure or restart after that transition becomes
  `ambiguous` and never causes a blind resend.
- Every claim increments a persistent generation. Every lease-owned state
  change includes that generation in its predicate, so a timed-out attempt
  that finishes during a later claim cannot move the row. Baileys also
  rechecks the abort signal after the awaited transport fence.
- Ambiguous operations reconcile only against the exact planned WhatsApp ID in
  the EVO `Message` table. When found, the worker continues with the Chatwoot
  callback; when absent, it remains ambiguous for operator visibility.
- Callback starts only after every frozen part has an exact durable WAID. The
  leader then PATCHes every part in canonical index order with `status=sent`,
  its raw WAID as `source_id`, and `provider_delivery` containing the stable
  operation key as `part_key` plus the zero-based `part_index` and immutable
  `part_count` (maximum 100). Chatwoot retains every mapping and chooses part
  zero as the message's canonical `source_id` only after all parts confirm.
  The PATCH is actual `application/json`; `provider_delivery` is a nested
  object with exactly `part_key`, `part_index`, and `part_count`, never a
  multipart/FormData string.
- EVO validates each PATCH response: exact message ID, valid message status,
  contract version 1, exact requested part fields, exact known source-ID
  mappings, acknowledgement count, and aggregate `message_confirmed` value.
  A complete response must use the primary WAID and `sent`, `delivered`, or
  `read`. Mapping order in the response is irrelevant; conflicting or foreign
  mappings fail closed.
- If callback part N fails after earlier acknowledgements succeeded, EVO leaves
  the whole operation `callback_pending`. Retry replays the same canonical
  callback sequence; Chatwoot treats identical mappings idempotently and the
  sequence converges after restart or outage. Callback retry never invokes
  WhatsApp. The whole message becomes `completed` only after every response is
  acknowledged. A terminal failure callback is accepted only for the exact
  message ID and `failed` status.
- If one multipart sibling ends in a confirmed pre-send failure while another
  has an exact WAID, the worker atomically completes the message as
  `PartialDelivery`, publishes only the confirmed mappings, and never resends
  or discards the delivered sibling.
- With `CHATWOOT_OUTBOUND_ASYNC_ENABLED=false`, new messages retain the legacy
  synchronous path, but a retained ledger row always wins: an already accepted
  or completed message cannot replay through synchronous transport during
  cutover or rollback.
- Deletion requires the same authoritative exact-message snapshot to report
  `deleted=true`. In the send-success/callback-outage window, EVO validates the
  deterministic planned WAID against exact retained `contextInfo` provenance
  when the top-level Chatwoot mapping fields are still null. Any populated
  conflicting mapping remains a binding mismatch.
- Logs contain only state/error classes and aggregate counts. Do not log the
  payload, phone/JID, body, media URL, route binding or customer identifiers.

Backoff begins at five seconds and is capped at five minutes. Claims use a
ten-minute database lease. Expired `preparing` leases return to `pending`;
expired `sending` leases become `ambiguous`; callback leases are reclaimed.
The deployment contract uses a single application process, while the
database claim still prevents concurrent workers from taking the same row.

## Additive schema and deployment

Apply the provider-specific migration before enabling the flag. It adds only
`ChatwootOutboundOperation`, its indexes, an `Instance` foreign key, and the
additive claim-generation fence. No
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
7. Verify every part PATCH returns `provider_delivery` contract version 1,
   exact `part_key/index/count`, the exact accumulated `source_ids` mapping and
   correct `acknowledged_part_count`. The final response must additionally have
   `message_confirmed=true`, `source_id=<part-zero raw WAID>`, and status
   `sent|delivered|read`. Failure acknowledgement remains
   `{ id: <exact message id>, status: failed }`.

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

1. Establish and record an explicit ingress cutoff, then keep
   `CHATWOOT_OUTBOUND_ASYNC_ENABLED=true` and set
   `CHATWOOT_OUTBOUND_ASYNC_DRAIN_ONLY=true`, and restart the current reviewed
   image. New eligible webhooks receive 503 and therefore are not accepted;
   the worker continues draining already committed operations. Do not use
   `CHATWOOT_OUTBOUND_ASYNC_ENABLED=false` as the ingress fence while Chatwoot
   can still retry or redeliver a webhook.
2. Observe aggregate states until no rows remain in `pending`, `preparing`,
   `sending`, `callback_pending`, `failure_callback_pending`, or
   `delete_pending`.
3. Reconcile every `ambiguous` row only by its exact planned WAID. Investigate
   `quarantined` rows against the captured origin/binding. Neither state may be
   reset to `pending`, deleted, or blindly resent.
4. Only after all accepted work is terminal may the current compatible image
   set `CHATWOOT_OUTBOUND_ASYNC_ENABLED=false`; its retained-ledger guard must
   continue rejecting every operation at or before the cutoff.
5. Deploy the prior immutable EVO image only after additionally proving that no
   queued upstream webhook, retry, or redelivery can cross that cutoff. If this
   cannot be proven, keep the compatible image and roll forward. Leave the
   additive table and its rows in place.
6. Confirm the legacy synchronous source-ID contract and instance connectivity.

If the current worker cannot drain safely, stop the rollback and repair or
reconcile it under the current image. Deploying the legacy image is not a queue
recovery mechanism.

Rolling back Chatwoot and EVO are independent image operations, but Chatwoot
must retain the compatible optional `source_id` PATCH field while queued EVO
callbacks remain.
