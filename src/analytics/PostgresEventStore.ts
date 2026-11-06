import type { Pool } from 'pg';
import type { Json, Target } from './model.ts';
import { projectEvent } from './ProjectEvent.ts';

export class PostgresEventStore {

  private readonly pool: Pool;
  private readonly target: Target;
  private readonly repositories: string[];

  constructor(pool: Pool, target: Target, repositories: string[]) {
    this.pool = pool;
    this.target = target;
    this.repositories = repositories;
  }

  async projectId(): Promise<string> {
    const result = await this.pool.query<{ owner: string; project_number: number; project_id: string | null }>(
      'SELECT owner, project_number, project_id FROM analytics.source_identity');
    const identity = result.rows[0];
    if (!identity?.project_id || identity.owner !== this.target.owner.toLowerCase() || identity.project_number !== this.target.number) {
      throw new Error('A successful full import of the configured project is required before accepting events.');
    }
    return identity.project_id;
  }

  async record(deliveryId: string, name: string, payload: Json, receivedAt: Date): Promise<'stored' | 'duplicate' | 'ignored'> {
    const projectId = await this.projectId();
    const event = projectEvent(name, payload, this.target, projectId, this.repositories);
    if (!event) return 'ignored';
    const result = await this.pool.query(`
      INSERT INTO analytics.project_events
        (delivery_id, project_id, event_name, action, item_id, content_id, repository, source_updated_at, received_at, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
    [deliveryId, projectId, event.event, event.action, event.itemId, event.contentId, event.repository,
      event.sourceUpdatedAt, receivedAt, JSON.stringify(event.data)]);
    return result.rowCount ? 'stored' : 'duplicate';
  }
}
