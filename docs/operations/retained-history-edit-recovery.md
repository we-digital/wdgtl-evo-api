# Retained provider edits and unsupported controls

The cached v2 recovery path still requires the current instance, capability-bound
account/inbox, source ID, direction and exact stored key/body/timestamp. It never
sends a WhatsApp message. Unknown or contradictory payloads stop the batch.

An encrypted MESSAGE_EDIT is reconciled only against one retained original in
the same instance and peer, authored in the same business direction. Decryption
uses the pinned whatsmeow Message Edit HKDF-SHA256/AES-GCM algorithm and the
existing pinned Baileys protobuf; the decoded inner target must equal the entire
outer target key. Only text and caption-only document deltas are supported.
Original native source, key, UTC, author, attachment and media data are retained.
The existing public Chatwoot target must match source/direction/account/inbox,
current native cache bindings and exact peer. No missing original is imported.
Current native ordering/competitor checks run before each edit, and an optional
expected-content/attributes CAS is enforced by the coordinated CW endpoint under
its existing lock. Source/original rotation before response stops acknowledgement.

A NULL/empty retained edited text is not deletion. Like the existing image gap,
it can preserve one nonempty existing public matching text target without an
edit or import, reporting `preserved_existing_source_payload_unavailable`.
Official history acknowledgement must persist the versioned unresolved gap;
it does not mean the missing edit body has been recovered.

Typed pin and poll records have no complete Chatwoot UI integration here. They
return `preserved_unsupported_pin_control` or `preserved_unsupported_poll_control`
with unsupported recovery, and require the matching history-worker release to
retain their original payload/version in durable semantic-gap storage before
acknowledgement. Poll option labels or named votes are never invented. Known
reaction controls may contain existing provider metadata; unknown primary keys
still refuse. Do not activate these outcomes before both source releases and
current guarded synthetic/production acceptance are qualified.

Focused verification: `npx tsx --test tests/chatwoot-authenticated-history-edit.test.ts
 tests/chatwoot-unavailable-image-edit.test.ts tests/chatwoot-provider-edit.test.ts`,
`npx tsc --noEmit --incremental false`, and normal ESLint on the changed services
and utilities. Existing live routing/canonical conversation guards remain in
place; this change provides neither automatic job resume nor source-cache refresh.

Activation is a paired-release gate: deploy and immutably verify the CW locked
`provider_recovery_guard` implementation before any new EFO encrypted recovery
edit. An older CW controller may ignore that optional parameter; sending it is
not proof the CAS ran. Keep recovery paused until this prerequisite and the
matching official history gap consumer are verified. Native prechecks and the
final acknowledgement drift check are optimistic cross-database guards, not
an atomic native/CW snapshot.
