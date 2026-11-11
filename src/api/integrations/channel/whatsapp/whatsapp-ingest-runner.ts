import { Logger } from '@config/logger.config';
import { KeyedSerialRunner } from '@utils/keyed-serial-runner';

const logger = new Logger('WhatsappIngest');

/** Per-chat lanes for post-admission ingest work, shared by every Baileys instance. */
export const whatsappIngestRunner = new KeyedSerialRunner((_key, error) =>
  logger.error(
    JSON.stringify({ event: 'whatsapp_ingest_task_failed', errorClass: error instanceof Error ? error.name : 'Error' }),
  ),
);
