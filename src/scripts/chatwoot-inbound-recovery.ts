// Operator tool: node dist/chatwoot-inbound-recovery.js [--states=failed,pending] [--instances=a,b]
//   [--exclude-instances=t-test] [--errors=InboundX,...] [--apply --confirm=<planHash>]
// Default is a read-only report (aggregates only). --apply requeues exactly the
// reported plan: it refuses unless --confirm matches the plan hash computed now.
import { PrismaClient } from '@prisma/client';

import {
  applyRecovery,
  planRecovery,
  prismaRecoveryReader,
  prismaRecoveryWriter,
  recoveryReport,
} from '../api/integrations/chatbot/chatwoot/utils/chatwoot-inbound-recovery';

function option(name: string): string[] | undefined {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value ? value.split(',').filter(Boolean) : undefined;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const now = new Date();
    const filter = {
      states: option('states'),
      instanceNames: option('instances'),
      excludeInstanceNames: option('exclude-instances'),
      errorClasses: option('errors'),
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
  console.error(JSON.stringify({ error: error?.name || 'Error' }));
  process.exitCode = 1;
});
