# Baileys Group Sender-Key and Identity Recovery

## Purpose

Prevent group messages sent through the Baileys channel from remaining permanently at
`Waiting for this message. This may take a while` on one WhatsApp device while the same message is readable on another
linked device.

This is a compatibility layer for [WhiskeySockets/Baileys#2704](https://github.com/WhiskeySockets/Baileys/issues/2704),
which is confirmed against Baileys 7.0.0 release candidates including the upstream base `7.0.0-rc.9`.

## Failure mode

Baileys stores a per-group `sender-key-memory` map of devices that have already received the group sender key. When a
member changes phones or Signal identity without changing the account JID/LID, the map can remain stale. Baileys then
sends the encrypted group message without a new Sender Key Distribution Message (SKDM). A device with the old key can
read the message; the changed device cannot.

The production incident on 2026-07-18 also showed `Closing session ... pendingPreKey` log entries around failed group
messages. This is a useful identity/session-rotation trace, but not an error or sufficient proof on its own. The decisive
evidence was device-selective decryption failure, together with new post-deployment messages remaining unreadable on the
affected primary phone after a group-only `sender-key-memory` reset. That result proved that the device/session caches
also had to be refreshed.

## Controlled dependency

Production uses the controlled public fork [we-digital/Baileys](https://github.com/we-digital/Baileys), not an untracked
working-tree patch:

- release: [`wdgtl-v7.0.0-rc.9.4`](https://github.com/we-digital/Baileys/releases/tag/wdgtl-v7.0.0-rc.9.4)
- package version: `7.0.0-rc.9-wdgtl.4`
- fork commit: `1e4e955a5e4b4beda7e37f9efee57ef9193e52cd`
- upstream base: `v7.0.0-rc.9` / `cb8b3717aaede47460ba700651ee936f268c0ce4`
- release asset SHA-512 is pinned by `package-lock.json`

The release implements six compatibility and recovery paths:

1. On a WhatsApp identity-change notification, resolve PN/LID aliases, evict their device-cache entries, force fresh
   pairwise Signal sessions, and remove only those devices from all stored group sender-key memories.
2. Before the first send to each group on a new socket connection, fetch uncached participant devices, force their
   pairwise sessions, and reset the group's sender-key delivery memory.
3. Before later sends, retain the inexpensive group-memory reset as a defense-in-depth fallback.
4. On a participant-hash rejection, perform a bounded full repair and retry the original message once.
5. Preserve libsignal session state transitions without logging complete `SessionEntry` objects or their key material.
6. Emit validated `lid-mapping.update` events when mappings are learned from history, migration, message alternate JIDs,
   or app-state contact actions so Evolution API can reconcile provisional Chatwoot contacts.

The identity scan calls `groupFetchAllParticipating(false)`. The `false` is operationally important: emitting
`groups.update` caused Evolution API to fan out a metadata query for every group. On the 2026-07-18 production rollout,
an account with 114 groups generated 94 WhatsApp `rate-overlimit` responses. Release `.2` suppresses events only for the
internal recovery scan while preserving the public method's default behavior.

`BAILEYS_FORCE_GROUP_SENDER_KEY_REFRESH=true` enables the proactive send-time paths in Evolution API. Identity-change
and participant-hash recovery live in the fork and remain event-driven.

The reset deliberately uses `this.client.authState.keys`. The socket key store is wrapped by
`makeCacheableSignalKeyStore`; writing directly to `this.instance.authState.state.keys` would leave the in-memory cache
stale for up to five minutes.

The proactive mitigation is scoped to `@g.us` destinations. Direct chats and broadcast/status sends are unchanged.

Evolution API logs the observable recovery counters:

- `Fully repaired sender keys for group ... participants, ... devices, ... sessions`
- `Identity recovery for ... sessions refreshed, ... sender-key entries removed ...`

## Operational cost

The first send to a group per socket connection performs one extra group-metadata query, one uncached device query, and
forced pairwise-session checks. Every group send can include fresh SKDM fanout because the memory is reset. This is
acceptable for the low-volume operational groups in this deployment, but the flag should be reviewed before enabling it
for high-volume or very large groups.

## Deployment and rollback

The production flag is owned by `we-digital/bbc-devops` in `droplets/evo/runtime.env`.

1. Set `BAILEYS_FORCE_GROUP_SENDER_KEY_REFRESH=true` in the production runtime environment.
2. Verify `package.json` and `package-lock.json` point to the immutable controlled release asset above.
3. Build and deploy the Evolution API image containing the compatibility layer.
4. Confirm the container package reports `7.0.0-rc.9-wdgtl.4` and the recovery log appears on the next group send.
5. Send a new test message and verify it on the affected primary mobile and linked devices. Old placeholders cannot be
   repaired because their ciphertext was already delivered without an available key.
6. Roll back the application image first if runtime errors appear. The prior image uses the same auth/database state.
7. Disable the feature flag only when deliberately reverting to the old group-memory-only behavior.

No database migration or WhatsApp QR relink is required.

## Acceptance test

1. Use a group containing the Evolution API sender, an affected primary mobile device, and at least one linked
   WhatsApp Web/Desktop device.
2. Send the same new text through Evolution API.
3. Confirm the text is readable on the primary mobile device and every linked device.
4. Confirm a direct-message send still succeeds.
5. Confirm Evolution API remains connected and no key-store error appears in container logs.
6. Confirm a `Fully repaired sender keys` log for the tested group reports non-zero devices and sessions.
7. Confirm forced recovery does not log full `SessionEntry` objects, private/session keys, or `Opening/Closing session`.
8. Restart the socket or container and repeat once; the first-send recovery must be deterministic after reconnect.

## Upgrade checklist

Before upgrading Evolution API or Baileys:

1. Read this runbook and the fork's `FORK_NOTES.md` before changing Evolution API or Baileys.
2. Check issue #2704, related sender-key/SKDM changes, and upstream PRs. An open or version-bumped PR is not a fix.
3. Diff the candidate upstream source against fork commit `1e4e955`; account for identity notifications, PN/LID aliases,
   device-cache eviction, forced session refresh, silent group enumeration, sender-key invalidation, and participant-hash
   retry separately. Ensure session lifecycle logs cannot contain key material.
4. Keep the controlled dependency and production flag unless every required behavior is present upstream.
5. Generate Prisma, run `npm run build`, `npm run lint:check`, build the production Docker image, and run the acceptance
   test with the feature flag enabled.
6. To evaluate removal, use a disposable test phone that has actually re-registered or changed Signal identity. Test
   with the flag disabled after reconnect, on primary mobile and linked devices, across repeated sends.
7. Remove the fork or flag only when the exact upstream commit is identified and the disabled-layer regression test
   passes consistently. Never infer this from a release number alone.
8. Record the upstream/fork commits, container image tag, test group, devices, timestamps, and result in the upgrade PR.

## Maintaining the fork

Do not force-push or retag a released package. For a new patch:

1. Rebase or cherry-pick onto a new `wdgtl/*` branch in `we-digital/Baileys`.
2. Run the fork unit tests, TypeScript build, and lint.
3. Merge through a reviewed PR and create a new immutable release/tag/package version.
4. Update both lockfiles through npm; do not use a floating branch, Git SSH dependency, or mutable asset.
5. Update this runbook with the new fork commit and removal analysis.
