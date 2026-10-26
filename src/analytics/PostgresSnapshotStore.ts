import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import type { Json, ProjectSnapshot, Target } from './model.ts';

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

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async withLock<T>(operation: (session: SnapshotSession) => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(741936201) AS locked');
      locked = result.rows[0]!.locked;
      if (!locked) return null;
      await client.query(await readFile(new URL('../../analytics/schema.sql', import.meta.url), 'utf8'));
      return await operation(new SnapshotSession(client));
    } finally {
      try {
        if (locked) await client.query('SELECT pg_advisory_unlock(741936201)');
      } finally {
        client.release();
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
