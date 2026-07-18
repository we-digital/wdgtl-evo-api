# Baileys Group Sender-Key Refresh

## Purpose

Prevent group messages sent through the Baileys channel from remaining permanently at
`Waiting for this message. This may take a while` on one WhatsApp device while the same message is readable on another
linked device.

This is a local mitigation for [WhiskeySockets/Baileys#2704](https://github.com/WhiskeySockets/Baileys/issues/2704),
which is confirmed against Baileys 7.0.0 release candidates including the currently deployed `7.0.0-rc.9`.

## Failure mode

Baileys stores a per-group `sender-key-memory` map of devices that have already received the group sender key. When a
member changes phones or Signal identity without changing the account JID/LID, the map can remain stale. Baileys then
sends the encrypted group message without a new Sender Key Distribution Message (SKDM). A device with the old key can
read the message; the changed device cannot.

The production incident on 2026-07-18 showed `Closing session ... pendingPreKey` log entries at the same times as the
failed group messages. This matches the symptom described in Baileys issues
[#1701](https://github.com/WhiskeySockets/Baileys/issues/1701) and
[#2704](https://github.com/WhiskeySockets/Baileys/issues/2704).

## Mitigation

When `BAILEYS_FORCE_GROUP_SENDER_KEY_REFRESH=true`, `BaileysStartupService.sendMessage()` clears the target group's
`sender-key-memory` immediately before a group send. The next Baileys send recomputes current participant devices and
redistributes the sender key.

The reset deliberately uses `this.client.authState.keys`. The socket key store is wrapped by
`makeCacheableSignalKeyStore`; writing directly to `this.instance.authState.state.keys` would leave the in-memory cache
stale for up to five minutes.

The mitigation is scoped to `@g.us` destinations. Direct chats and broadcast/status sends are unchanged.

## Operational cost

Each group send can include additional pairwise key messages for current participant devices. This is acceptable for
low-volume operational groups, but the flag should be reviewed before enabling it for high-volume or very large groups.

## Deployment and rollback

The production flag is owned by `we-digital/bbc-devops` in `droplets/evo/runtime.env`.

1. Set `BAILEYS_FORCE_GROUP_SENDER_KEY_REFRESH=true` in the production runtime environment.
2. Build and deploy the Evolution API image containing the mitigation.
3. Resend a new test message; old placeholders cannot be repaired because their ciphertext was already delivered
   without an available key.
4. Roll back by setting the flag to `false` and redeploying, or by deploying the previous image tag.

No database migration or WhatsApp QR relink is required.

## Acceptance test

1. Use a group containing the Evolution API sender, an affected primary mobile device, and at least one linked
   WhatsApp Web/Desktop device.
2. Send the same new text through Evolution API.
3. Confirm the text is readable on the primary mobile device and every linked device.
4. Confirm a direct-message send still succeeds.
5. Confirm Evolution API remains connected and no key-store error appears in container logs.

## Upgrade checklist

Before upgrading Evolution API or Baileys:

1. Check the status and merged fix for Baileys issue #2704 and related sender-key/SKDM changes.
2. Keep this patch and the production flag unless the exact upstream fix is present.
3. Build the candidate image and run the acceptance test with the flag enabled.
4. To evaluate removal, run the same test with the flag disabled against a phone whose Signal identity changed or was
   re-registered.
5. Remove the mitigation only when the disabled-flag test passes consistently on primary mobile and linked devices.
6. Record the tested Baileys version and result in the upgrade PR.
