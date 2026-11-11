// Operator tool, two modes. Both default to a read-only report (aggregates only);
// --apply changes exactly the reported plan and refuses unless --confirm matches
// the plan hash computed at that moment.
//
// Ledger rows:  node dist/chatwoot-inbound-recovery.js [--states=failed,pending] [--instances=a,b]
//   [--exclude-instances=t-test] [--errors=InboundX,...] [--history-older-than-hours=2]
//   [--skip-unsupported] [--apply --confirm=<planHash>]
// Native gaps (stored in EVO, no ledger row, not linked to Chatwoot):
//   node dist/chatwoot-inbound-recovery.js --native-since=2026-11-02T00:00:00Z [--native-until=ISO]
//   --instances=a [--skip-unsupported] [--apply --confirm=<planHash>]
// --skip-unsupported closes types Chatwoot cannot render (stickers, templates,
// buttons, polls, product/order) as ignored ledger rows: terminal, never delivered.
// Run native gaps one instance at a time: the window index is read into memory.
import { PrismaClient } from '@prisma/client';

import {
  applyNativeGaps,
  nativeGapReport,
  planNativeGaps,
  prismaNativeGapReader,
  prismaNativeGapWriter,
} from '../api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-native-gaps';
import {
  applyRecovery,
  planRecovery,
  prismaRecoveryReader,
  prismaRecoveryWriter,
  recoveryReport,
} from '../api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-recovery';

// Live messages younger than this are still the live path's job.
const NATIVE_SETTLE_MS = 15 * 60_000;

function option(name: string): string[] | undefined {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value ? value.split(',').filter(Boolean) : undefined;
}
function date(name: string): Date | undefined {
  const value = option(name)?.[0];
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw Object.assign(new Error(`invalid --${name}`), { name: 'UsageError' });
  return parsed;
}

async function nativeGaps(prisma: PrismaClient, now: Date) {
  const since = date('native-since');
  const latest = new Date(now.getTime() - NATIVE_SETTLE_MS);
  const requested = date('native-until');
  const until = requested && requested < latest ? requested : latest;
  const filter = {
    since,
    until,
    instanceNames: option('instances'),
    excludeInstanceNames: option('exclude-instances'),
    skipUnsupported: process.argv.includes('--skip-unsupported'),
  };
  const plan = await planNativeGaps(prismaNativeGapReader(prisma), filter);
  const report = nativeGapReport(plan, now);
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ mode: 'native-dry-run', filter, ...report }, null, 2));
    return;
  }
  if (option('confirm')?.[0] !== plan.planHash) {
    console.error(
      JSON.stringify({ mode: 'native-apply', refused: 'plan hash mismatch: run the dry-run again', ...report }),
    );
    process.exitCode = 2;
    return;
  }
  const result = await applyNativeGaps(plan, prismaNativeGapWriter(prisma), now);
  console.log(JSON.stringify({ mode: 'native-apply', filter, planHash: plan.planHash, ...result }, null, 2));
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const now = new Date();
    if (option('native-since')) return await nativeGaps(prisma, now);
    const hours = Number(option('history-older-than-hours')?.[0]);
    const filter = {
      states: option('states'),
      instanceNames: option('instances'),
      excludeInstanceNames: option('exclude-instances'),
      errorClasses: option('errors'),
      skipUnsupported: process.argv.includes('--skip-unsupported'),
      ...(Number.isFinite(hours) && hours > 0 ? { historyOlderThanMs: hours * 3_600_000 } : {}),
    };
    const plan = await planRecovery(prismaRecoveryReader(prisma), filter, now);
    const report = recoveryReport(plan, now);
    if (!process.argv.includes('--apply')) {
      console.log(JSON.stringify({ mode: 'dry-run', filter, ...report }, null, 2));
      return;
    }
    if (option('confirm')?.[0] !== plan.planHash) {
      console.error(JSON.stringify({ mode: 'apply', refused: 'plan hash mismatch: run the dry-run again', ...report }));
      process.exitCode = 2;
      return;
    }
    const result = await applyRecovery(plan, prismaRecoveryWriter(prisma), now);
    console.log(JSON.stringify({ mode: 'apply', filter, planHash: plan.planHash, ...result }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error?.name || 'Error',
      ...(error?.name === 'UsageError' ? { message: error.message } : {}),
    }),
  );
  process.exitCode = 1;
});
