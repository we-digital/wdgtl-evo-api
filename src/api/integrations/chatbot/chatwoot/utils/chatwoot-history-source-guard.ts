import type { Pool } from 'pg';

const canonicalSourceId = (sourceId: string) => (sourceId.startsWith('WAID:') ? sourceId : `WAID:${sourceId}`);

const CREATE_GUARD_TABLE = `
  CREATE TABLE IF NOT EXISTS evolution_history_source_guards (
    inbox_id BIGINT NOT NULL,
    source_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (inbox_id, source_id)
  )`;

const CREATE_GUARD_FUNCTION = `
  CREATE OR REPLACE FUNCTION evolution_enforce_history_source_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $guard$
  DECLARE
    canonical_source_id TEXT;
    raw_source_id TEXT;
  BEGIN
    IF NEW.inbox_id IS NULL OR NEW.source_id IS NULL THEN
      RETURN NEW;
    END IF;

    -- ORMs may include unchanged identity columns in a status/content update.
    -- Existing legacy aliases must not block that update; new/rebound identities
    -- still pass through the locked uniqueness check below.
    IF TG_OP = 'UPDATE' AND NEW.inbox_id IS NOT DISTINCT FROM OLD.inbox_id
       AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id THEN
      RETURN NEW;
    END IF;

    canonical_source_id := CASE
      WHEN LEFT(NEW.source_id, 5) = 'WAID:' THEN NEW.source_id
      ELSE 'WAID:' || NEW.source_id
    END;
    raw_source_id := SUBSTRING(canonical_source_id FROM 6);

    PERFORM 1
      FROM evolution_history_source_guards
     WHERE inbox_id = NEW.inbox_id
       AND source_id = canonical_source_id
     FOR UPDATE;

    IF FOUND AND EXISTS (
      SELECT 1
        FROM messages
       WHERE inbox_id = NEW.inbox_id
         AND (source_id = canonical_source_id OR source_id = raw_source_id)
         AND id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION 'duplicate guarded history source id'
        USING ERRCODE = '23505', CONSTRAINT = 'evolution_history_source_guard_unique';
    END IF;

    RETURN NEW;
  END
  $guard$`;

const CREATE_GUARD_TRIGGER = `
  DO $guard$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger
       WHERE tgname = 'evolution_history_source_guard_trigger'
         AND tgrelid = 'messages'::regclass
         AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER evolution_history_source_guard_trigger
      BEFORE INSERT OR UPDATE OF inbox_id, source_id ON messages
      FOR EACH ROW
      EXECUTE FUNCTION evolution_enforce_history_source_guard();
    END IF;
  END
  $guard$`;

export async function activateChatwootHistorySourceGuards(
  pool: Pool,
  inboxId: number,
  sourceIds: string[],
): Promise<void> {
  const canonicalSourceIds = [...new Set(sourceIds.map(canonicalSourceId))];
  if (canonicalSourceIds.length === 0) return;
  const aliases = [...new Set(canonicalSourceIds.flatMap((sourceId) => [sourceId, sourceId.slice(5)]))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Close the gap with statements that started before the trigger existed.
    await client.query('LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE');
    await client.query(CREATE_GUARD_TABLE);
    await client.query(CREATE_GUARD_FUNCTION);
    await client.query(CREATE_GUARD_TRIGGER);
    const duplicates = await client.query(
      `SELECT 1
         FROM messages
        WHERE inbox_id = $1
          AND source_id = ANY($2::text[])
        GROUP BY CASE WHEN LEFT(source_id, 5) = 'WAID:' THEN source_id ELSE 'WAID:' || source_id END
       HAVING COUNT(*) > 1
        LIMIT 1`,
      [inboxId, aliases],
    );
    if (duplicates.rowCount) {
      throw new Error('Chatwoot history source guard found an existing duplicate');
    }
    await client.query(
      `INSERT INTO evolution_history_source_guards (inbox_id, source_id)
       SELECT $1, source_id
         FROM UNNEST($2::text[]) AS source_id
       ON CONFLICT (inbox_id, source_id) DO NOTHING`,
      [inboxId, canonicalSourceIds],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
