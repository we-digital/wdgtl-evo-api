/** Synthetic payload scale check; no database, provider, secrets or customer data. */
import { storedHistoryPages } from '../src/api/integrations/chatbot/chatwoot/utils/history-memory-budget';

const mode = process.argv[2];
if (mode !== 'whole' && mode !== 'paged') throw new Error('Use whole|paged');
const count = Number(process.argv[3] || 20000);
let maxRows = 0;
const make = (index: number) => ({
  id: String(index).padStart(8, '0'),
  instanceId: 'synthetic',
  messageTimestamp: 1700000000 + Math.floor(index / 300),
  key: { id: `native-${index}`, remoteJid: '628100000001@s.whatsapp.net' },
  // Materialize separate strings as a database driver would; avoid shared ropes.
  message: JSON.parse(JSON.stringify({ conversation: `${index}:` + 'synthetic payload '.repeat(960) })),
});
const repository: any = {
  findMany: async (args: any) => {
    if (args.orderBy?.[0]?.messageTimestamp === 'desc') return [make(count - 1)];
    const after = args.where?.AND?.[2]?.OR?.[1]?.id?.gt;
    const start = after === undefined ? 0 : Number(after) + 1;
    const size = Math.min(args.take ?? count, count - start);
    maxRows = Math.max(maxRows, size);
    return Array.from({ length: size }, (_, offset) => make(start + offset));
  },
};
async function main() {
  const before = process.memoryUsage();
  const started = performance.now();
  let visited = 0;
  let checksum = 0;
  if (mode === 'whole') {
    const rows = await repository.findMany({ where: { instanceId: 'synthetic' } });
    for (const row of rows) {
      visited++;
      checksum += Number(row.id);
    }
  } else {
    for await (const page of storedHistoryPages(repository, { instanceId: 'synthetic' }))
      for (const row of page) {
        visited++;
        checksum += Number(row.id);
      }
  }
  console.log(
    JSON.stringify({
      mode,
      count,
      visited,
      checksum,
      maxPayloadRows: maxRows,
      seconds: (performance.now() - started) / 1000,
      baselineRssBytes: before.rss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
}
void main();
