import assert from 'node:assert/strict';
import test from 'node:test';

import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

const group = '120363000000000001@g.us';

function service(meta: unknown) {
  const wa: any = Object.create(BaileysStartupService.prototype);
  const calls: string[] = [];
  wa.getGroupMetadataCache = async (jid: string) => {
    calls.push(jid);
    if (meta instanceof Error) throw meta;
    return meta;
  };
  return { wa, calls };
}

test('a group send recipient comes from cached metadata, without live metadata or profile-picture queries', async () => {
  const { wa, calls } = service({ id: group, subject: 'Synthetic group' });
  const recipient = await wa.cachedGroupRecipient(group);
  assert.deepEqual(calls, [group]);
  assert.equal(recipient.exists, true);
  assert.equal(recipient.jid, group);
});

test('a cache miss or error falls back to the full whatsappNumber path', async () => {
  assert.equal(await service(null).wa.cachedGroupRecipient(group), undefined);
  assert.equal(await service(new Error('synthetic')).wa.cachedGroupRecipient(group), undefined);
});

test('direct numbers are not resolved from the group cache', async () => {
  const { wa, calls } = service({ id: group });
  assert.equal(await wa.cachedGroupRecipient('628111111111'), undefined);
  assert.deepEqual(calls, []);
});
