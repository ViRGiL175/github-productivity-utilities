import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import type { EventEnrichment, Json, PendingEvents, ProjectSnapshot, Target } from './model.ts';

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: Json): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export class PostgresSnapshotStore {

  private readonly pool: Pool;
  private schemaReady = false;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async withLock<T>(operation: (session: SnapshotSession) => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    let locked = false;
    let discard = false;
    let connectionError: Error | undefined;
    const onError = (error: Error) => { connectionError = error; };
    client.on('error', onError);
    try {
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(741936201) AS locked');
      locked = lock.rows[0]!.locked;
      if (!locked) return null;
      if (!this.schemaReady) {
        await client.query(await readFile(new URL('../../analytics/schema.sql', import.meta.url), 'utf8'));
        this.schemaReady = true;
      }
      const result = await operation(new SnapshotSession(client));
      if (connectionError) throw connectionError;
      return result;
    } catch (error) {
      discard = true;
      throw error;
    } finally {
      try {
        if (locked && !discard && !connectionError) await client.query('SELECT pg_advisory_unlock(741936201)');
      } catch (error) {
        discard = true;
        throw error;
      } finally {
        client.release(discard || connectionError !== undefined);
        client.removeListener('error', onError);
      }
    }
  }
}

export class SnapshotSession {

  private readonly client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async bind(target: Target): Promise<void> {
    await this.client.query(`INSERT INTO analytics.source_identity (owner, project_number)
      VALUES ($1, $2) ON CONFLICT (singleton) DO NOTHING`, [target.owner.toLowerCase(), target.number]);
    const result = await this.client.query<{ owner: string; project_number: number }>('SELECT owner, project_number FROM analytics.source_identity');
    const stored = result.rows[0]!;
    if (stored.owner !== target.owner.toLowerCase() || stored.project_number !== target.number) {
      throw new Error('This database is already bound to a different project. Use a separate database and Compose project.');
    }
  }

  async lastCompletedAt(): Promise<Date | null> {
    const result = await this.client.query<{ completed_at: Date | null }>("SELECT max(completed_at) AS completed_at FROM analytics.sync_runs WHERE status = 'complete'");
    return result.rows[0]!.completed_at;
  }

  async pendingEvents(): Promise<PendingEvents | null> {
    const result = await this.client.query<PendingEvents>(`
      WITH next AS (
        SELECT e.project_id, e.content_id FROM analytics.project_events e
        JOIN analytics.source_identity s ON s.project_id=e.project_id
        WHERE e.enriched_at IS NULL AND (e.enrichment_retry_at IS NULL OR e.enrichment_retry_at <= now())
        ORDER BY e.received_at DESC, e.revision DESC LIMIT 1
      )
      SELECT e.project_id AS "projectId", e.content_id AS "contentId",
        array_agg(e.delivery_id::text ORDER BY e.revision) AS deliveries,
        bool_or(e.event_name='sub_issues') AS "needsParentHistory",
        bool_and(COALESCE(e.event_name='projects_v2_item' AND e.action<>'converted'
          AND e.data->>'content_type'='DraftIssue',false)) AS "draftOnly"
      FROM analytics.project_events e JOIN next n USING (project_id, content_id)
      WHERE e.enriched_at IS NULL
      GROUP BY e.project_id, e.content_id`);
    return result.rows[0] ?? null;
  }

  async enrichEvents(events: PendingEvents, enrichment: EventEnrichment): Promise<void> {
    // Only acknowledge the captured deliveries. Events arriving during the read remain pending.
    // Store the observation once; the other deliveries point to it, preserving their original data.
    await this.client.query(`UPDATE analytics.project_events SET
      enrichment=CASE WHEN delivery_id=$2::uuid THEN $3::jsonb ELSE jsonb_build_object('delivery_id',$2::text) END,
      enriched_at=$4, enrichment_retry_at=NULL
      WHERE delivery_id=ANY($1::uuid[]) AND enriched_at IS NULL`,
    [events.deliveries, events.deliveries[0], JSON.stringify({
      read_started_at: enrichment.startedAt.toISOString(), observed_at: enrichment.observedAt.toISOString(),
      deliveries: events.deliveries, observations: enrichment.observations, parent_events: enrichment.parentEvents,
    }), enrichment.observedAt]);
  }

  async retryEvents(events: PendingEvents, delayMs = 60_000): Promise<void> {
    await this.client.query(`UPDATE analytics.project_events SET enrichment_retry_at=now()+$2::double precision*interval '1 millisecond'
      WHERE delivery_id=ANY($1::uuid[]) AND enriched_at IS NULL`, [events.deliveries, delayMs]);
  }

  async begin(): Promise<string> {
    await this.client.query(`UPDATE analytics.sync_runs SET status = 'failed', completed_at = now(), failure_code = 'interrupted'
      WHERE status = 'running'`);
    const id = randomUUID();
    await this.client.query("INSERT INTO analytics.sync_runs (id, started_at, status) VALUES ($1, now(), 'running')", [id]);
    return id;
  }

  async fail(runId: string): Promise<void> {
    await this.client.query(`UPDATE analytics.sync_runs SET status = 'failed', completed_at = now(), failure_code = 'collection_or_storage_failed'
      WHERE id = $1 AND status = 'running'`, [runId]);
  }

  async save(runId: string, snapshot: ProjectSnapshot): Promise<{ items: number; changed: number; missing: number }> {
    if (snapshot.complete !== true || snapshot.expectedCount !== snapshot.items.length ||
        new Set(snapshot.items.map(item => item.id)).size !== snapshot.expectedCount) {
      throw new Error('Only a complete snapshot with unique item IDs can be committed.');
    }
    await this.client.query('BEGIN');
    try {
      await this.bind(snapshot.target);
      const identity = await this.client.query<{ project_id: string | null }>('SELECT project_id FROM analytics.source_identity FOR UPDATE');
      const projectId = identity.rows[0]!.project_id;
      if (projectId && projectId !== snapshot.project.id) throw new Error('Project identity changed.');
      await this.client.query('UPDATE analytics.source_identity SET project_id = $1 WHERE project_id IS NULL', [snapshot.project.id]);
      const projectHash = fingerprint(snapshot.project);
      const projectUpdate = await this.client.query(`
        INSERT INTO analytics.project_current (snapshot, fingerprint, observed_at) VALUES ($1, $2, $3)
        ON CONFLICT (singleton) DO UPDATE SET snapshot = EXCLUDED.snapshot, fingerprint = EXCLUDED.fingerprint, observed_at = EXCLUDED.observed_at
        WHERE analytics.project_current.fingerprint <> EXCLUDED.fingerprint RETURNING singleton`,
      [JSON.stringify(snapshot.project), projectHash, snapshot.observedAt]);
      if (projectUpdate.rowCount) {
        await this.client.query('INSERT INTO analytics.project_history (run_id, observed_at, snapshot, fingerprint) VALUES ($1, $2, $3, $4)',
          [runId, snapshot.observedAt, JSON.stringify(snapshot.project), projectHash]);
      }
      let changed = 0;
      for (const item of snapshot.items) {
        const hash = fingerprint(item);
        const data = JSON.stringify(item);
        const updated = await this.client.query(`
          INSERT INTO analytics.item_current (item_id, snapshot, fingerprint, first_observed_at, observed_at)
          VALUES ($1, $2, $3, $4, $4)
          ON CONFLICT (item_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, fingerprint = EXCLUDED.fingerprint,
            observed_at = EXCLUDED.observed_at, missing_since = NULL
          WHERE analytics.item_current.fingerprint <> EXCLUDED.fingerprint OR analytics.item_current.missing_since IS NOT NULL
          RETURNING item_id`, [item.id, data, hash, snapshot.observedAt]);
        if (updated.rowCount) {
          changed++;
          await this.client.query(`INSERT INTO analytics.item_history (item_id, run_id, observed_at, kind, snapshot, fingerprint)
            VALUES ($1, $2, $3, 'observed', $4, $5)`, [item.id, runId, snapshot.observedAt, data, hash]);
        }
      }
      const missing = await this.client.query<{ item_id: string; snapshot: Json; fingerprint: string }>(`
        UPDATE analytics.item_current SET missing_since = $2, observed_at = $2
        WHERE missing_since IS NULL AND NOT (item_id = ANY($1::text[]))
        RETURNING item_id, snapshot, fingerprint`, [snapshot.items.map(item => item.id), snapshot.observedAt]);
      for (const item of missing.rows) {
        await this.client.query(`INSERT INTO analytics.item_history (item_id, run_id, observed_at, kind, snapshot, fingerprint)
          VALUES ($1, $2, $3, 'missing', $4, $5)`, [item.item_id, runId, snapshot.observedAt, JSON.stringify(item.snapshot), item.fingerprint]);
      }
      await this.client.query(`UPDATE analytics.sync_runs SET status = 'complete', observed_at = $2, completed_at = now(),
        item_count = $3, changed_count = $4, missing_count = $5 WHERE id = $1`,
      [runId, snapshot.observedAt, snapshot.items.length, changed, missing.rows.length]);
      await this.client.query('COMMIT');
      return { items: snapshot.items.length, changed, missing: missing.rows.length };
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}
