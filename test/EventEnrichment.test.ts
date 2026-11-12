import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEnrichmentReader } from '../src/analytics/EventEnrichmentReader.ts';
import type { EventEnrichment, Json, PendingEvents } from '../src/analytics/model.ts';
import { PostgresEventStore } from '../src/analytics/PostgresEventStore.ts';
import { SnapshotSession } from '../src/analytics/PostgresSnapshotStore.ts';

const target = { owner: 'example', number: 1 };
const projectId = 'PVT_example';
const sourceTime = '2026-01-02T08:00:00Z';
const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });

function card(id: string, parent: string | null, points = 3, horizon = 'focus') {
  const fields: Array<Record<string, Json>> = [
    { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { id: 'horizon', name: 'Horizon', dataType: 'SINGLE_SELECT' }, optionId: horizon, name: horizon },
    { __typename: 'ProjectV2ItemFieldNumberValue', field: { id: 'points', name: 'Points', dataType: 'NUMBER' }, number: points },
    { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { id: 'status', name: 'Status', dataType: 'SINGLE_SELECT' }, optionId: 'todo', name: 'Todo' },
  ];
  return { id: `PI_${id}`, type: 'ISSUE', isArchived: false, createdAt: sourceTime, updatedAt: sourceTime,
    content: { __typename: 'Issue', id, title: 'Private title', body: 'Private body', state: 'OPEN', stateReason: null as string | null,
      parent: parent ? { id: parent } : null, createdAt: sourceTime, updatedAt: sourceTime, closedAt: null as string | null,
      repository: { nameWithOwner: 'example/backlog' } }, fields };
}
type Card = ReturnType<typeof card>;
type ParentEvent = { __typename: string; id: string; createdAt: string; parent: { id: string } };
const page = (nodes: unknown[], totalCount = nodes.length, next: string | null = null) =>
  ({ nodes, totalCount, pageInfo: { hasNextPage: next !== null, endCursor: next } });

function github(cards: Card[]) {
  const state = { history: [] as ParentEvent[], fail: false, beforeRead: undefined as (() => Promise<void>) | undefined };
  const byId = new Map(cards.map(item => [item.content.id, item]));
  const graphql = vi.fn(async (query: string, variables: { id: string; after?: string | null }) => {
    if (state.fail) throw new Error('GitHub unavailable');
    const beforeRead = state.beforeRead;
    state.beforeRead = undefined;
    await beforeRead?.();
    if (query.includes('timelineItems')) {
      const rows = variables.after ? state.history.slice(1) : state.history.slice(0, 1);
      return { node: { timelineItems: page(rows, state.history.length, !variables.after && state.history.length > 1 ? 'next' : null) } };
    }
    if (query.includes('fieldValues')) {
      const item = byId.get(variables.id.slice(3))!;
      const { fields, ...identity } = item;
      return { node: { ...identity, project: { id: projectId }, fieldValues: variables.after
        ? page(fields.slice(1), fields.length) : page(fields.slice(0, 1), fields.length, 'next') } };
    }
    if (query.includes('projectItems')) {
      const item = byId.get(variables.id)!;
      return { node: { ...item.content, projectItems: page([
        { id: item.id, updatedAt: item.updatedAt, isArchived: item.isArchived, project: { id: projectId } },
      ]) } };
    }
    throw new Error('Unexpected GraphQL query');
  });
  return { state, graphql, client: { graphql } as unknown as Pick<Octokit, 'graphql'> };
}

const pending = (needsParentHistory = false): PendingEvents =>
  ({ projectId, contentId: 'I_child', deliveries: [randomUUID()], needsParentHistory });
const reader = (api: ReturnType<typeof github>) => new EventEnrichmentReader(api.client, target.owner, ['backlog']);
function created(id = 'I_child'): Json {
  return { action: 'created', organization: { login: target.owner }, projects_v2_item: {
    node_id: `PI_${id}`, project_node_id: projectId, content_node_id: id, content_type: 'Issue', updated_at: sourceTime,
  } };
}

async function database() {
  const db = new PGlite();
  databases.push(db);
  await db.exec('CREATE SCHEMA analytics');
  await db.exec(await readFile(new URL('../analytics/schema.sql', import.meta.url), 'utf8'));
  // Execute production SQL in PostgreSQL; adapt only the pg result envelope.
  const connection = { async query(sql: string, values?: unknown[]) {
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } };
  const session = new SnapshotSession(connection as unknown as PoolClient);
  await session.bind(target);
  await db.query('UPDATE analytics.source_identity SET project_id=$1', [projectId]);
  return { db, session, connection, restart: () => new SnapshotSession(connection as unknown as PoolClient) };
}

async function full(db: PGlite, session: SnapshotSession, items: Card[], at: string) {
  const id = await session.begin();
  await db.query("UPDATE analytics.sync_runs SET started_at=$2::timestamptz-interval '1 minute' WHERE id=$1", [id, at]);
  return session.save(id, { target, project: { id: projectId }, items, complete: true, expectedCount: items.length,
    startedAt: new Date(at), observedAt: new Date(at) });
}

describe('Event enrichment', () => {
  it('loads a new issue, every field page and its ancestry without losing zero or retaining private text', async () => {
    const child = card('I_child', 'I_root', 0);
    child.fields.push({ __typename: 'ProjectV2ItemFieldTextValue', field: { id: 'text', name: 'Note', dataType: 'TEXT' }, text: 'Private note' });
    const api = github([child, card('I_root', null, 5, 'ideas')]);
    const result = await reader(api).read(pending());
    expect(result.observations).toMatchObject([
      { content_id: 'I_child', parent_id: 'I_root', present: true, snapshot: { fields: [
        { optionId: 'focus' }, { number: 0 }, { name: 'Todo' },
      ] } },
      { content_id: 'I_root', parent_id: null, snapshot: { fields: [{ optionId: 'ideas' }, { number: 5 }, { name: 'Todo' }] } },
    ]);
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(result.parentEvents).toEqual([]);
  });

  it('waits for delayed parent history and preserves event time separately from the issue clock', async () => {
    const api = github([card('I_child', null)]);
    api.state.history = [{ __typename: 'ParentIssueAddedEvent', id: 'E_added', createdAt: '2026-01-02T08:30:00Z', parent: { id: 'I_root' } }];
    await expect(reader(api).read(pending(true))).rejects.toThrow('Parent history has not caught up');
    api.state.history.push({ __typename: 'ParentIssueRemovedEvent', id: 'E_removed', createdAt: '2026-01-02T09:00:00Z', parent: { id: 'I_root' } });
    const result = await reader(api).read(pending(true));
    expect(result.parentEvents).toEqual([
      { id: 'E_added', created_at: '2026-01-02T08:30:00Z', parent_id: 'I_root', linked: true },
      { id: 'E_removed', created_at: '2026-01-02T09:00:00Z', parent_id: 'I_root', linked: false },
    ]);
    expect(result.observations).toMatchObject([{ parent_id: null, snapshot: { content: { parent: null, updatedAt: sourceTime } } }]);
  });

  it('keeps failed and in-flight deliveries across a collector restart and acknowledges duplicates once', async () => {
    const { db, session, connection, restart } = await database();
    const wake = vi.fn();
    const events = new PostgresEventStore(connection as unknown as Pool, target, ['backlog'], wake);
    const first = randomUUID(), duringRead = randomUUID();
    expect(await events.record(first, 'projects_v2_item', created(), new Date())).toBe('stored');
    expect(await events.record(first, 'projects_v2_item', created(), new Date())).toBe('duplicate');
    expect(wake).toHaveBeenCalledTimes(1);
    const batch = (await session.pendingEvents())!;
    const api = github([card('I_child', null)]);
    api.state.fail = true;
    await expect(reader(api).read(batch)).rejects.toThrow('GitHub unavailable');
    await session.retryEvents(batch);
    const restarted = restart();
    expect(await restarted.pendingEvents()).toBeNull();
    await db.exec("UPDATE analytics.project_events SET enrichment_retry_at=now()-interval '1 second'");
    expect((await restarted.pendingEvents())!.deliveries).toEqual([first]);
    api.state.fail = false;
    api.state.beforeRead = async () => { await events.record(duringRead, 'projects_v2_item', created(), new Date()); };
    await restarted.enrichEvents(batch, await reader(api).read(batch));
    const next = (await restart().pendingEvents())!;
    expect(next.deliveries).toEqual([duringRead]);
    await restarted.enrichEvents(next, await reader(api).read(next));
    expect(await restart().pendingEvents()).toBeNull();
    expect(wake).toHaveBeenCalledTimes(2);
    expect((await db.query('SELECT count(*)::int AS n FROM analytics.project_events WHERE enriched_at IS NOT NULL')).rows).toEqual([{ n: 2 }]);
    expect((await db.query('SELECT count(*)::int AS n FROM analytics.sync_runs')).rows).toEqual([{ n: 0 }]);
  }, 20_000);

  it('publishes every series from one completed full collection while retaining earlier weekly snapshots', async () => {
    const { db, session, connection } = await database();
    const closed = (item: Card, at: string) => ({ ...item,
      content: { ...item.content, state: 'CLOSED', stateReason: 'COMPLETED', closedAt: at },
      fields: item.fields.map(f => (f.field as Record<string, Json>).id === 'status' ? { ...f, name: 'Done' } : f),
    });
    const initial = [card('I_root', null, 5), card('I_child', 'I_root', 3, 'ideas'),
      card('I_ideas', null, 100, 'ideas'), card('I_nested_focus', 'I_ideas', 13),
      closed(card('I_prior', null, 20), '2026-09-29T10:00:00Z')];
    await full(db, session, initial, '2026-10-05T00:00:00Z');
    await full(db, session, initial, '2026-10-11T23:30:00Z');
    await full(db, session, initial, '2026-10-13T10:00:00Z');
    const completedAt = await session.lastCompletedAt();
    const dashboard = await patchedDashboard();
    const variable = dashboard.templating.list.find(v => v.name === 'focusSnapshot')!;
    const selected = async () => (await db.query<{ __value: string; __text: string }>(variable.query)).rows[0]!;
    const query = async (ref: string, id: string) => (await db.query<Record<string, unknown>>(dashboard.panels[0]!.targets
      .find(t => t.refId === ref)!.rawSql.replaceAll('${focusSnapshot:sqlstring}', '$1'), [id])).rows;
    const graph = async (id: string) => Promise.all(['A', 'B', 'C'].map(ref => query(ref, id)));
    const publication = await selected();
    expect(publication.__text).toBe('13.10.2026 10:00:00 UTC');
    const before = await graph(publication.__value);
    const latest = (rows: Record<string, unknown>[]) => rows.at(-1)!;
    expect(latest(before[0]!)).toMatchObject({ 'Остаток · снимки': 8, 'Прирост · снимки': 0 });
    expect(before[1]!.length).toBeGreaterThan(0);
    expect(before[2]!.length).toBeGreaterThan(0);
    const newItem = card('I_new', null, 7);
    newItem.content.createdAt = '2026-10-14T11:00:00Z';
    const api = github([card('I_child', null, 3, 'ideas'), newItem]);
    api.state.history = [{ __typename: 'ParentIssueRemovedEvent', id: 'E_removed', createdAt: '2026-10-14T11:00:00Z', parent: { id: 'I_root' } }];
    const events = new PostgresEventStore(connection as unknown as Pool, target, ['backlog']);
    await events.record(randomUUID(), 'sub_issues', { action: 'parent_issue_removed', organization: { login: target.owner },
      repository: { full_name: 'example/backlog' }, sub_issue: { node_id: 'I_child' }, parent_issue: { node_id: 'I_root' } }, new Date('2026-10-14T11:00:00Z'));
    await events.record(randomUUID(), 'projects_v2_item', created('I_new'), new Date('2026-10-14T11:00:01Z'));
    expect(await graph(publication.__value)).toEqual(before);
    for (let batch = await session.pendingEvents(); batch; batch = await session.pendingEvents()) {
      const result: EventEnrichment = { ...await reader(api).read(batch),
        startedAt: new Date('2026-10-14T11:01:00Z'), observedAt: new Date('2026-10-14T11:02:00Z') };
      await session.enrichEvents(batch, result);
    }
    expect(await graph(publication.__value)).toEqual(before);
    expect(await selected()).toEqual(publication);
    expect(await session.lastCompletedAt()).toEqual(completedAt);
    const unfinished = await session.begin();
    expect(await selected()).toEqual(publication);
    await session.fail(unfinished);
    expect(await selected()).toEqual(publication);
    // A new full collection can commit between A and B/C without mixing publications.
    const aBeforeCommit = await query('A', publication.__value);
    const reconciled = [closed(initial[0]!, '2026-10-14T12:00:00Z'), card('I_child', null, 3, 'ideas'), ...initial.slice(2), newItem];
    expect(await full(db, session, reconciled, '2026-10-15T10:00:00Z')).toEqual({ items: 6, changed: 3, missing: 0 });
    expect([aBeforeCommit, await query('B', publication.__value), await query('C', publication.__value)]).toEqual(before);
    const updated = await selected();
    expect(updated.__text).toBe('15.10.2026 10:00:00 UTC');
    const after = await graph(updated.__value);
    expect(latest(after[0]!)).toMatchObject({ 'Выполнено · нынешний фокус': 5, 'Остаток · снимки': 0, 'Прирост · снимки': 7,
      'Время снимка остатка · UTC': Date.parse('2026-10-15T10:00:00Z') });
    const historicalSnapshots = (rows: Record<string, unknown>[]) => rows.slice(0, -1)
      .filter(row => row['Время снимка остатка · UTC'] !== null);
    expect(historicalSnapshots(after[0]!)).toEqual(historicalSnapshots(before[0]!));
    expect(latest(after[1]!).time).toEqual(new Date('2026-10-15T10:00:00Z'));
    expect(after[2]![0]!.time).toEqual(new Date('2026-10-15T10:00:00Z'));
    await full(db, session, reconciled, '2026-10-18T23:30:00Z');
    await full(db, session, reconciled, '2026-10-19T00:30:00Z');
    const nextWeek = await query('A', (await selected()).__value);
    expect(latest(nextWeek)).toMatchObject({ 'Остаток · снимки': 7, 'Прирост · снимки': 0 });
    expect(await graph(publication.__value)).toEqual(before);
  }, 30_000);
});

type Dashboard = { panels: Array<{ title: string; description: string; targets: Array<{ refId: string; rawSql: string }> }>;
  templating: { list: Array<{ name: string; query: string }> } };
async function patchedDashboard(): Promise<Dashboard> {
  // The existing weekly SQL, with empty audit lists and synthetic field IDs, exercises all three actual queries.
  const dir = await mkdtemp(join(tmpdir(), 'analytics-enrichment-'));
  const input = join(dir, 'input.json'), output = join(dir, 'output.json');
  const dashboard = JSON.parse(await readFile(new URL('./fixtures/weekly-focus.json', import.meta.url), 'utf8'));
  try {
    await writeFile(input, JSON.stringify(dashboard));
    execFileSync(process.execPath, ['scripts/patch-weekly-focus-publication.mjs', input, output]);
    const patched = JSON.parse(await readFile(output, 'utf8'));
    expect(patched.panels[1]).toEqual(dashboard.panels[1]);
    expect(patched.panels[0].title).toContain('${focusSnapshot:text}');
    expect(patched.templating.list[0]).toMatchObject({ refresh: 2, hide: 2, skipUrlSync: true, multi: false });
    expect(patched.panels[0].fieldConfig.defaults).toEqual(dashboard.panels[0].fieldConfig.defaults);
    expect(patched.panels[0].options).toEqual(dashboard.panels[0].options);
    expect(patched.panels[0].gridPos).toEqual(dashboard.panels[0].gridPos);
    return patched;
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
    await rmdir(dir);
  }
}
