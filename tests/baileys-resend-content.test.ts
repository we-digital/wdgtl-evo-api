import assert from 'node:assert/strict';
import test from 'node:test';

import { RecentOutboundMessages } from '../src/api/integrations/channel/whatsapp/recent-outbound-messages';
import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

const group = '120363000000000000@g.us';
const reaction = {
  reactionMessage: {
    key: { id: 'TARGET', fromMe: false, remoteJid: group, participant: '1@lid' },
    text: '⏳',
    senderTimestampMs: 1,
  },
};

function service(rows: any[] | Error) {
  const wa: any = Object.create(BaileysStartupService.prototype);
  wa.instance = { id: 'synthetic-instance', name: 'synthetic' };
  wa.logger = { warn() {}, info() {}, debug() {}, error() {} };
  wa.prismaRepository = {
    $queryRaw: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
  return wa;
}

test('a message not in the database yields no content, never an empty text placeholder', async () => {
  const wa = service([]);
  assert.equal(await wa.getMessage({ id: 'REACTION', remoteJid: group, fromMe: true }), undefined);
});

test('a failed lookup yields no content, never an empty text placeholder', async () => {
  const wa = service(new Error('db down'));
  assert.equal(await wa.getMessage({ id: 'REACTION', remoteJid: group, fromMe: true }), undefined);
  assert.equal(await wa.getMessage({ id: 'REACTION', remoteJid: group, fromMe: true }, true), undefined);
});

test('a just-sent reaction is resent as itself before its database row exists', async () => {
  const wa = service([]);
  wa.recentOutboundMessages = new RecentOutboundMessages();
  wa.recentOutboundMessages.remember({ key: { id: 'REACTION', remoteJid: group, fromMe: true }, message: reaction });
  assert.deepEqual(await wa.getMessage({ id: 'REACTION', remoteJid: group, fromMe: true }), reaction);
});

test('a stored message is still read from the database', async () => {
  const wa = service([{ message: { conversation: 'hello' } }]);
  wa.recentOutboundMessages = new RecentOutboundMessages();
  assert.deepEqual(await wa.getMessage({ id: 'TEXT', remoteJid: group, fromMe: true }), { conversation: 'hello' });
});

test('recent outbound copies expire and stay bounded', () => {
  let now = 0;
  const recent = new RecentOutboundMessages(1000, 2, () => now);
  recent.remember({ key: { id: 'A' }, message: { conversation: 'a' } });
  recent.remember({ key: { id: 'B' }, message: { conversation: 'b' } });
  recent.remember({ key: { id: 'C' }, message: { conversation: 'c' } });
  assert.equal(recent.get('A'), undefined);
  assert.deepEqual(recent.get('C'), { conversation: 'c' });
  now = 1000;
  assert.equal(recent.get('B'), undefined);
  recent.remember({ key: { id: 'D' } });
  assert.equal(recent.get('D'), undefined);
});
