import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  findStoredHistoryIds,
  storedHistoryPages,
} from '../src/api/integrations/chatbot/chatwoot/utils/history-memory-budget';

test(
  'real synthetic PostgreSQL JSON lookup and equal-timestamp keysets remain scoped and bounded',
  {
    skip: process.env.HISTORY_MEMORY_POSTGRES_TEST !== '1',
  },
  async () => {
    const uri = new URL(process.env.DATABASE_CONNECTION_URI!);
    assert.equal(uri.hostname, 'postgres', 'Only the private shared-lab PostgreSQL is admitted');
    const prisma = new PrismaClient();
    const marker = 'task050-' + randomUUID();
    try {
      await assert.rejects(
        prisma.$transaction(
          async (tx) => {
            const one = await tx.instance.create({ data: { name: marker, connectionStatus: 'close' } });
            const two = await tx.instance.create({ data: { name: marker + '-foreign', connectionStatus: 'close' } });
            await tx.message.createMany({
              data: Array.from({ length: 751 }, (_, index) => ({
                id: marker + String(index).padStart(5, '0'),
                instanceId: index === 750 ? two.id : one.id,
                key: { id: `NATIVE-${index}`, remoteJid: '628100000001@s.whatsapp.net', fromMe: false },
                messageTimestamp: 1700000000 + Math.floor(index / 300),
                messageType: 'conversation',
                source: 'web',
                message: { conversation: 'synthetic-only-' + index },
              })),
            });
            const found = await findStoredHistoryIds(tx.message, one.id, ['NATIVE-1', 'NATIVE-749', 'NATIVE-750']);
            assert.deepEqual([...found].sort(), ['NATIVE-1', 'NATIVE-749']);
            const ids: string[] = [];
            for await (const page of storedHistoryPages(tx.message, { instanceId: one.id })) {
              assert.ok(page.length <= 250);
              ids.push(...page.map((row) => row.id));
            }
            assert.equal(ids.length, 750);
            assert.equal(new Set(ids).size, 750);
            const keyIds: string[] = [];
            for await (const page of storedHistoryPages(tx.message, { instanceId: one.id }, { key: true })) {
              assert.ok(page.length <= 250);
              assert.ok(page.every((row) => !('message' in row)));
              keyIds.push(...page.map((row) => row.id));
            }
            assert.deepEqual(keyIds, ids);
            throw new Error('rollback-synthetic-task050');
          },
          { timeout: 30000 },
        ),
        /rollback-synthetic-task050/,
      );
      assert.equal(await prisma.instance.count({ where: { name: { startsWith: marker } } }), 0);
    } finally {
      await prisma.$disconnect();
    }
  },
);
