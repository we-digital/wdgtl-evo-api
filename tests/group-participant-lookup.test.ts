import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts';
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function subject(participants: any[], contacts: any[], source = fs.readFileSync(sourcePath, 'utf8')) {
  const ast = ts.createSourceFile('channel.ts', source, ts.ScriptTarget.Latest, true);
  const klass = ast.statements.find(ts.isClassDeclaration)!;
  const method = klass.members.find(member => member.name?.getText(ast) === 'findParticipants')!.getText(ast);
  const calls = { metadata: [] as string[], queries: [] as any[], cache: [] as any[] };
  const context = { module: { exports: undefined as any },
    saveOnWhatsappCache: async (rows: any[]) => { calls.cache.push(plain(rows)); },
    NotFoundException: Error, console };
  vm.runInNewContext(ts.transpileModule(`module.exports = class { ${method} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const instance = new context.module.exports();
  instance.instanceId = 'synthetic-A';
  instance.client = { groupMetadata: async (jid: string) => {
    calls.metadata.push(jid);
    return { participants };
  } };
  instance.prismaRepository = { contact: { findMany: async (query: any) => {
    calls.queries.push(plain(query));
    // Model database scope and selected columns; never expose the other tenant.
    return contacts.filter(contact => contact.instanceId === query.where.instanceId &&
      query.where.remoteJid.in.includes(contact.remoteJid)).map(contact => query.select
        ? Object.fromEntries(Object.keys(query.select).map(key => [key, contact[key]])) : contact);
  } } };
  return { instance, calls };
}

test('group roster preserves provider fields, nullish fallback, order, alias-row precedence and tenant scope', async () => {
  const participants = [
    { id: '1@lid', phoneNumber: '11@s.whatsapp.net', lid: '111@lid', admin: 'superadmin' },
    { id: '2@s.whatsapp.net', name: '', imgUrl: '', admin: null },
    { id: '3@lid', phoneNumber: '33@s.whatsapp.net', name: 'Provider name', imgUrl: 'provider-photo' },
    { id: '4@lid', name: null, imgUrl: null },
    { id: '5@lid' },
    { id: '6@s.whatsapp.net', phoneNumber: '11@s.whatsapp.net' },
  ];
  const contacts = [
    { instanceId: 'synthetic-B', remoteJid: '1@lid', pushName: 'Foreign', profilePicUrl: 'foreign' },
    { instanceId: 'synthetic-A', remoteJid: '11@s.whatsapp.net', pushName: 'First returned alias', profilePicUrl: 'first' },
    { instanceId: 'synthetic-A', remoteJid: '1@lid', pushName: 'Later exact ID', profilePicUrl: 'later' },
    { instanceId: 'synthetic-A', remoteJid: '111@lid', pushName: 'Later LID', profilePicUrl: 'later-lid' },
    { instanceId: 'synthetic-A', remoteJid: '2@s.whatsapp.net', pushName: 'Saved', profilePicUrl: 'saved' },
    { instanceId: 'synthetic-A', remoteJid: '33@s.whatsapp.net', pushName: 'Saved third', profilePicUrl: 'third' },
    { instanceId: 'synthetic-A', remoteJid: '4@lid', pushName: null, profilePicUrl: null },
  ];
  const { instance, calls } = subject(participants, contacts);
  const before = plain(participants);
  const result = plain(await instance.findParticipants({ groupJid: 'synthetic@g.us' }));
  assert.deepEqual(result.participants.map((p: any) => [p.id, p.name, p.imgUrl]), [
    ['1@lid', 'First returned alias', 'first'], ['2@s.whatsapp.net', '', ''],
    ['3@lid', 'Provider name', 'provider-photo'], ['4@lid', null, null], ['5@lid', undefined, undefined],
    ['6@s.whatsapp.net', 'First returned alias', 'first'],
  ]);
  assert.equal(result.participants[0].admin, 'superadmin');
  assert.deepEqual(plain(participants), before, 'do not mutate the metadata snapshot');
  assert.deepEqual(calls.metadata, ['synthetic@g.us']);
  assert.equal(calls.queries.length, 1);
  assert.deepEqual(calls.queries[0], { where: { instanceId: 'synthetic-A', remoteJid: { in: [
    '1@lid', '11@s.whatsapp.net', '111@lid', '2@s.whatsapp.net', '3@lid', '33@s.whatsapp.net',
    '4@lid', '5@lid', '6@s.whatsapp.net', '11@s.whatsapp.net',
  ] } }, select: { remoteJid: true, pushName: true, profilePicUrl: true } });
  assert.deepEqual(calls.cache, [[{ remoteJid: '2@s.whatsapp.net' }, { remoteJid: '6@s.whatsapp.net' }]]);
});

test('empty and unsaved rosters retain the existing cache and response contract', async () => {
  for (const participants of [[], [{ id: 'unsaved@lid' }]]) {
    const { instance, calls } = subject(participants, []);
    assert.deepEqual(plain(await instance.findParticipants({ groupJid: 'synthetic@g.us' })), { participants });
    assert.equal(calls.queries.length, 1);
    assert.deepEqual(calls.cache, [[]]);
  }
});

const baselinePath = process.env.EVO_GROUP_LOOKUP_BASELINE_SOURCE;
test('synthetic roster before/after equivalence and benchmark', { skip: !baselinePath }, async () => {
  const baseline = fs.readFileSync(baselinePath!, 'utf8');
  const comparisons: Record<string, number> = {};
  const participants = Array.from({ length: 1024 }, (_, i) => ({ id: `${i}@lid`, phoneNumber: `${i}@s.whatsapp.net` }));
  const contacts = participants.flatMap(p => [p.phoneNumber, p.id].map(remoteJid => ({
    id: `synthetic-${remoteJid}`, instanceId: 'synthetic-A', remoteJid, pushName: 'Synthetic name',
    profilePicUrl: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  })));
  // Also compare adversarial contact order, shared aliases, unsaved peers and nullish provider fields.
  for (let seed = 0; seed < 20; seed++) {
    const peers = participants.slice(0, 20).map((p, i) => ({ ...p, phoneNumber: `${(i + seed) % 23}@s.whatsapp.net`,
      lid: `${(i + seed) % 17}@lid`, name: i % 3 ? undefined : '', imgUrl: i % 2 ? null : 'provider' }));
    const rows = contacts.slice(0, 40).sort((a, b) => ((Number(a.remoteJid.split('@')[0]) * 13 + seed) % 23) -
      ((Number(b.remoteJid.split('@')[0]) * 13 + seed) % 23));
    assert.deepEqual(plain(await subject(peers, rows).instance.findParticipants({ groupJid: 'synthetic@g.us' })),
      plain(await subject(peers, rows, baseline).instance.findParticipants({ groupJid: 'synthetic@g.us' })));
  }
  for (const [name, source] of [['baseline', baseline], ['candidate', fs.readFileSync(sourcePath, 'utf8')]]) {
    let reads = 0;
    const rows = contacts.map(contact => ({ ...contact, get remoteJid() { reads++; return contact.remoteJid; } }));
    const { instance } = subject(participants, rows, source);
    instance.prismaRepository.contact.findMany = async () => rows;
    await instance.findParticipants({ groupJid: 'synthetic@g.us' });
    comparisons[name] = reads;
  }
  const cases: any[] = [];
  for (const count of [1, 32, 1024]) {
    const peers = participants.slice(0, count);
    const rows = contacts.slice(0, count * 2);
    const timings: Record<string, number[]> = { baseline: [], candidate: [] };
    const readers = { baseline: subject(peers, rows, baseline).instance, candidate: subject(peers, rows).instance };
    // Exclude database/mock filtering time; execute the literal methods with identical query results.
    for (const instance of Object.values(readers)) instance.prismaRepository.contact.findMany = async () => rows;
    for (let sample = 0; sample < 11; sample++) {
      const results: any[] = [];
      for (const name of (sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])) {
        const start = performance.now();
        const result = await readers[name].findParticipants({ groupJid: 'synthetic@g.us' });
        timings[name].push(Number((performance.now() - start).toFixed(3)));
        results.push(plain(result));
      }
      assert.deepEqual(results[0], results[1]);
    }
    const projected = rows.map(({ remoteJid, pushName, profilePicUrl }) => ({ remoteJid, pushName, profilePicUrl }));
    cases.push({ participants: peers.length, contacts: rows.length, timings,
      syntheticContactJsonBytes: { baseline: Buffer.byteLength(JSON.stringify(rows)),
        candidate: Buffer.byteLength(JSON.stringify(projected)) } });
  }
  assert(comparisons.candidate < comparisons.baseline / 100);
  console.log('EVO_GROUP_LOOKUP_PERFORMANCE ' + JSON.stringify({ cases, largeRosterContactJidReads: comparisons,
    scope: 'literal method CPU and synthetic Contact JSON; mocked database/provider/cache; not wire bytes or endpoint latency' }));
});
