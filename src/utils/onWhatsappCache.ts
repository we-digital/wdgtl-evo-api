import { prismaRepository } from '@api/server.module';
import { configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import dayjs from 'dayjs';

const logger = new Logger('OnWhatsappCache');

function getAvailableNumbers(remoteJid: string) {
  const numbersAvailable: string[] = [];

  if (remoteJid.startsWith('+')) {
    remoteJid = remoteJid.slice(1);
  }

  const [number, domain] = remoteJid.split('@');

  // TODO: Se já for @lid, retornar apenas ele mesmo SEM adicionar @domain novamente
  if (domain === 'lid' || domain === 'g.us') {
    return [remoteJid]; // Retorna direto para @lid e @g.us
  }

  // Brazilian numbers
  if (remoteJid.startsWith('55')) {
    const numberWithDigit =
      number.slice(4, 5) === '9' && number.length === 13 ? number : `${number.slice(0, 4)}9${number.slice(4)}`;
    const numberWithoutDigit = number.length === 12 ? number : number.slice(0, 4) + number.slice(5);

    numbersAvailable.push(numberWithDigit);
    numbersAvailable.push(numberWithoutDigit);
  }

  // Mexican/Argentina numbers
  // Ref: https://faq.whatsapp.com/1294841057948784
  else if (number.startsWith('52') || number.startsWith('54')) {
    let prefix = '';
    if (number.startsWith('52')) {
      prefix = '1';
    }
    if (number.startsWith('54')) {
      prefix = '9';
    }

    const numberWithDigit =
      number.slice(2, 3) === prefix && number.length === 13
        ? number
        : `${number.slice(0, 2)}${prefix}${number.slice(2)}`;
    const numberWithoutDigit = number.length === 12 ? number : number.slice(0, 2) + number.slice(3);

    numbersAvailable.push(numberWithDigit);
    numbersAvailable.push(numberWithoutDigit);
  }

  // Other countries
  else {
    numbersAvailable.push(remoteJid);
  }

  // TODO: Adiciona @domain apenas para números que não são @lid
  return numbersAvailable.map((number) => `${number}@${domain}`);
}

interface ISaveOnWhatsappCacheParams {
  remoteJid: string;
  remoteJidAlt?: string;
  lid?: 'lid' | undefined;
  /** Just verified by WhatsApp: renew the entry's freshness even when its data is unchanged. */
  verified?: boolean;
}

function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  return jid.startsWith('+') ? jid.slice(1) : jid;
}

// Every stored direct message calls saveOnWhatsappCache for its chat. An item that
// was saved unchanged a moment ago needs no database round trip at all.
const SAVE_MEMO_TTL_MS = 10 * 60 * 1000;
const SAVE_MEMO_MAX = 20_000;
const saveMemo = new Map<string, number>();
function saveMemoKey(item: ISaveOnWhatsappCacheParams): string {
  return [normalizeJid(item.remoteJid) ?? '', normalizeJid(item.remoteJidAlt) ?? '', item.lid ?? ''].join('|');
}
function recentlySaved(key: string, now: number): boolean {
  const at = saveMemo.get(key);
  if (at === undefined) return false;
  if (now - at <= SAVE_MEMO_TTL_MS) return true;
  saveMemo.delete(key);
  return false;
}
function rememberSaved(key: string, now: number) {
  if (saveMemo.size >= SAVE_MEMO_MAX) saveMemo.delete(saveMemo.keys().next().value);
  saveMemo.set(key, now);
}
/** Test hook. */
export function clearOnWhatsappSaveMemo() {
  saveMemo.clear();
}

// Bounded parallelism: contacts.upsert can pass hundreds of items at once.
const SAVE_CONCURRENCY = 4;

/**
 * Finds the cache row of a JID set. The unique remoteJid index answers almost every
 * lookup; the jidOptions substring scan (a sequential scan of the whole table) only
 * runs when no row is keyed by one of the JIDs.
 */
async function findExistingRecord(remoteJid: string, expandedJids: string[]) {
  const exact = await prismaRepository.isOnWhatsapp.findFirst({
    where: { remoteJid: { in: [...new Set([remoteJid, ...expandedJids])] } },
  });
  if (exact) return exact;
  return prismaRepository.isOnWhatsapp.findFirst({
    where: { OR: expandedJids.map((jid) => ({ jidOptions: { contains: jid } })) },
  });
}

export async function saveOnWhatsappCache(data: ISaveOnWhatsappCacheParams[]) {
  if (!configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    return;
  }

  const queue = [...data];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await saveOne(item);
  };
  await Promise.allSettled(Array.from({ length: Math.min(SAVE_CONCURRENCY, queue.length) }, worker));
}

async function saveOne(item: ISaveOnWhatsappCacheParams) {
  const memoKey = saveMemoKey(item);
  const now = Date.now();
  if (!item.verified && recentlySaved(memoKey, now)) return;
  {
    try {
      const remoteJid = normalizeJid(item.remoteJid);
      if (!remoteJid) {
        logger.warn('[saveOnWhatsappCache] Item skipped, missing remoteJid.');
        return;
      }

      const altJidNormalized = normalizeJid(item.remoteJidAlt);
      const lidAltJid = altJidNormalized && altJidNormalized.includes('@lid') ? altJidNormalized : null;

      const baseJids = [remoteJid]; // Garante que o remoteJid esteja na lista inicial
      if (lidAltJid) {
        baseJids.push(lidAltJid);
      }

      const expandedJids = baseJids.flatMap((jid) => getAvailableNumbers(jid));

      // 1. Busca entrada por jidOptions e também remoteJid
      // Às vezes acontece do remoteJid atual NÃO ESTAR no jidOptions ainda, ocasionando o erro:
      // 'Unique constraint failed on the fields: (`remoteJid`)'
      // Isso acontece principalmente em grupos que possuem o número do criador no ID (ex.: '559911223345-1234567890@g.us')
      const existingRecord = await findExistingRecord(remoteJid, expandedJids);

      logger.verbose(
        `[saveOnWhatsappCache] Register exists for [${expandedJids.join(',')}]? => ${existingRecord ? existingRecord.remoteJid : 'Not found'}`,
      );

      // 2. Unifica todos os JIDs usando um Set para garantir valores únicos
      const finalJidOptions = new Set(expandedJids);

      if (lidAltJid) {
        finalJidOptions.add(lidAltJid);
      }

      if (existingRecord?.jidOptions) {
        existingRecord.jidOptions.split(',').forEach((jid) => finalJidOptions.add(jid));
      }

      // 3. Prepara o payload final
      // Ordena os JIDs para garantir consistência na string final
      const sortedJidOptions = [...finalJidOptions].sort();
      const newJidOptionsString = sortedJidOptions.join(',');
      const newLid = item.lid === 'lid' || item.remoteJid?.includes('@lid') ? 'lid' : null;

      const dataPayload = {
        remoteJid: remoteJid,
        jidOptions: newJidOptionsString,
        lid: newLid,
      };

      // 4. Decide entre Criar ou Atualizar
      if (existingRecord) {
        // Compara a string de JIDs ordenada existente com a nova
        const existingJidOptionsString = existingRecord.jidOptions
          ? existingRecord.jidOptions.split(',').sort().join(',')
          : '';

        const isDataSame =
          existingRecord.remoteJid === dataPayload.remoteJid &&
          existingJidOptionsString === dataPayload.jidOptions &&
          existingRecord.lid === dataPayload.lid;

        if (isDataSame) {
          // Without renewing updatedAt, an entry past IS_ON_WHATSAPP_DAYS stays a cache miss forever and
          // every send to that number repeats the network onWhatsApp query.
          if (item.verified) {
            await prismaRepository.isOnWhatsapp.update({
              where: { id: existingRecord.id },
              data: { updatedAt: new Date() },
            });
          }
          logger.verbose(`[saveOnWhatsappCache] Data for ${remoteJid} is already up-to-date. Skipping update.`);
          rememberSaved(memoKey, now);
          return; // Pula para o próximo item
        }

        // Os dados são diferentes, então atualiza
        logger.verbose(
          `[saveOnWhatsappCache] Register exists, updating: remoteJid=${remoteJid}, jidOptions=${dataPayload.jidOptions}, lid=${dataPayload.lid}`,
        );
        await prismaRepository.isOnWhatsapp.update({
          where: { id: existingRecord.id },
          data: dataPayload,
        });
        rememberSaved(memoKey, now);
      } else {
        // Cria nova entrada
        logger.verbose(
          `[saveOnWhatsappCache] Register does not exist, creating: remoteJid=${remoteJid}, jidOptions=${dataPayload.jidOptions}, lid=${dataPayload.lid}`,
        );
        await prismaRepository.isOnWhatsapp.create({
          data: dataPayload,
        });
        rememberSaved(memoKey, now);
      }
    } catch (e) {
      // Loga o erro mas não para a execução dos outros promises
      logger.error(`[saveOnWhatsappCache] Error processing item for ${item.remoteJid}: `);
      logger.error(e);
    }
  }
}

export async function getOnWhatsappCache(remoteJids: string[]) {
  let results: {
    remoteJid: string;
    number: string;
    jidOptions: string[];
    lid?: string;
  }[] = [];

  if (configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    const remoteJidsWithoutPlus = remoteJids.map((remoteJid) => getAvailableNumbers(remoteJid)).flat();
    const fresh = {
      gte: dayjs().subtract(configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP_DAYS, 'days').toDate(),
    };

    // Exact keys first (unique index); the jidOptions substring scan only for the rest.
    const exact = remoteJidsWithoutPlus.length
      ? await prismaRepository.isOnWhatsapp.findMany({
          where: { remoteJid: { in: [...new Set(remoteJidsWithoutPlus)] }, updatedAt: fresh },
        })
      : [];
    const covered = new Set(exact.flatMap((row) => [row.remoteJid, ...row.jidOptions.split(',')]));
    const rest = remoteJidsWithoutPlus.filter((jid) => !covered.has(jid));
    const scanned = rest.length
      ? await prismaRepository.isOnWhatsapp.findMany({
          where: {
            OR: rest.map((remoteJid) => ({ jidOptions: { contains: remoteJid } })),
            id: { notIn: exact.map((row) => row.id) },
            updatedAt: fresh,
          },
        })
      : [];
    const onWhatsappCache = [...exact, ...scanned];

    results = onWhatsappCache.map((item) => ({
      remoteJid: item.remoteJid,
      number: item.remoteJid.split('@')[0],
      jidOptions: item.jidOptions.split(','),
      lid: item.lid,
    }));
  }

  return results;
}
