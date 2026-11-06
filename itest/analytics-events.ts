import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import type { Json, Target } from '../src/analytics/model.ts';
import { PostgresEventStore } from '../src/analytics/PostgresEventStore.ts';
import { webhookServer } from '../src/analytics/webhooks.ts';

export interface EventFixture {

  target: Target;
  repositories: string[];
  projectId: string;
  itemId: string;
  contentId: string;
}

function payload(fixture: EventFixture, updatedAt: string, from: number, to: number): Json {
  return {
    action: 'edited', organization: { login: fixture.target.owner },
    projects_v2_item: { node_id: fixture.itemId, project_node_id: fixture.projectId, content_node_id: fixture.contentId,
      content_type: 'Issue', updated_at: updatedAt },
    changes: { field_value: { field_node_id: 'PVTF_e2e_points', field_name: 'Points', field_type: 'number', from, to } },
  };
}

async function receiver(pool: Pool, fixture: EventFixture) {
  const secret = randomBytes(32).toString('hex');
  const eventPool = new Pool({ ...pool.options, max: 2,
    connectionTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 2500 });
  eventPool.on('error', () => { console.log('Webhook database connection closed; the next delivery will reconnect'); });
  const server = webhookServer(secret, new PostgresEventStore(eventPool, fixture.target, fixture.repositories));
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); } catch (error) { await eventPool.end(); throw error; }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/github/webhooks`;
  return {

    async send(id: string, value: Json): Promise<number> {
      const body = JSON.stringify(value);
      const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(5000), headers: {
        'content-type': 'application/json', 'x-github-event': 'projects_v2_item', 'x-github-delivery': id,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      } });
      await response.arrayBuffer();
      return response.status;
    },
    async close(): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally {
        await eventPool.end();
      }
    },
  };
}

export async function verifyEventRedelivery(pool: Pool, fixture: EventFixture): Promise<void> {
  const endpoint = await receiver(pool, fixture);
  const currentId = randomUUID();
  const lateId = randomUUID();
  const currentTime = '2026-01-02T00:00:00.000Z';
  const lateTime = '2026-01-01T00:00:00.000Z';
  const snapshot = async () => ({
    current: (await pool.query('SELECT * FROM analytics.item_current WHERE item_id=$1', [fixture.itemId])).rows,
    history: (await pool.query('SELECT * FROM analytics.item_history WHERE item_id=$1 ORDER BY revision', [fixture.itemId])).rows,
  });
  try {
    const before = await snapshot();
    assert.equal(before.current.length, 1);
    assert.ok(before.history.length > 0);
    const current = payload(fixture, currentTime, 3, 0);
    assert.deepEqual(await Promise.all([endpoint.send(currentId, current), endpoint.send(currentId, current)]), [204, 204]);
    assert.equal(await endpoint.send(lateId, payload(fixture, lateTime, 8, 3)), 204);
    assert.equal(await endpoint.send(currentId, current), 204);
    const rows = await pool.query(`SELECT delivery_id, source_updated_at, data->'field' AS field
      FROM analytics.project_events WHERE delivery_id=ANY($1::uuid[]) ORDER BY revision`, [[currentId, lateId]]);
    assert.deepEqual(rows.rows.map(row => [row.delivery_id, row.source_updated_at.toISOString(), row.field.from, row.field.to]),
      [[currentId, currentTime, 3, 0], [lateId, lateTime, 8, 3]]);
    assert.deepEqual(await snapshot(), before, 'Webhook delivery must not rewrite the polled state or its history');
    console.log('Signed concurrent/repeated deliveries are durable once; a late event preserves source time and polled state');
  } finally {
    await endpoint.close();
  }
}

export async function startDatabaseFailureProbe(pool: Pool, fixture: EventFixture) {
  const endpoint = await receiver(pool, fixture);
  const id = randomUUID();
  const event = payload(fixture, '2026-01-03T00:00:00.000Z', 3, 0);
  return {

    async assertUnavailable(): Promise<void> {
      assert.equal(await endpoint.send(id, event), 503, 'An unavailable database must not acknowledge the event');
      console.log('Signed delivery receives HTTP 503 while the real PostgreSQL is stopped');
    },
    async assertRecovered(): Promise<void> {
      const count = async () => (await pool.query('SELECT count(*)::int AS count FROM analytics.project_events WHERE delivery_id=$1', [id])).rows[0].count;
      assert.equal(await count(), 0);
      assert.equal(await endpoint.send(id, event), 204);
      assert.equal(await count(), 1, 'HTTP success must follow the durable insert');
      assert.equal(await endpoint.send(id, event), 204);
      assert.equal(await count(), 1);
      console.log('After database recovery the same delivery succeeds and is stored once');
    },
    close: endpoint.close,
  };
}
