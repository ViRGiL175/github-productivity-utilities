import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { Agent, request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Octokit } from '@octokit/rest';
import pg from 'pg';
import { ProjectV2Repository, type IterationDefinition } from '../src/github/ProjectV2Repository.ts';
import { analyticsSandbox } from './analytics-sandbox.ts';
import { cleanupLiveFixtures, verifyLiveEvents, type LiveEventQuery } from './analytics-live-events.ts';
import { startDatabaseFailureProbe, verifyEventRedelivery, type EventFixture } from './analytics-events.ts';
import { cleanupAttempts, saveFixtureJournal } from './analytics-fixture-state.ts';

const sandbox = await analyticsSandbox();
const { owner, backlog: repo, number: projectNumber } = sandbox;
const journal = '.local/analytics-e2e-fixture.json';
const marker = `ITEST-analytics-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
if (process.env.PROJECT_OWNER !== owner || process.env.PROJECT_NUMBER !== String(projectNumber)) {
  throw new Error('E2E must target the existing sandbox');
}
assert.ok(process.env.GITHUB_RUN_ID && process.env.FIXTURE_TOKEN, 'Run through the sandbox workflow');
assert.match(process.env.GITHUB_RUN_ID, /^\d+$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
const github = new Octokit({ auth: process.env.FIXTURE_TOKEN, request: { timeout: 30_000 }, log: { debug() {}, info() {}, warn() {}, error() {} } });
const projects = new ProjectV2Repository(github);
let phase = 'fixture_setup';

async function verifyGrafana(query: unknown, live: LiveEventQuery): Promise<void> {
  const origin = new URL('https://127.0.0.1:3301');
  const trusted = new Agent({ ca: await readFile(process.env.GRAFANA_TLS_CA_FILE!) });
  const untrusted = new Agent();
  const adminPassword = (await readFile('.local/secrets/grafana-admin', 'utf8')).trim();
  const credentials = (login: string, password: string) => `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
  const bootstrap = credentials('localadmin', adminPassword);
  async function api<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, authorization?: string, agent = trusted): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, origin), {
        method, agent, headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(data) as T }); } catch { reject(new Error('Grafana returned non-JSON data')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error('Grafana request timed out')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const users: number[] = [];
  const uid = 'analytics-e2e-access';
  let dashboardCreated = false;
  try {
    phase = 'grafana_tls';
    await assert.rejects(api('/api/health', 'GET', undefined, undefined, untrusted), error =>
      ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes((error as NodeJS.ErrnoException).code ?? ''));
    assert.equal((await api('/api/health')).status, 200);
    console.log('HTTPS validates the test CA and localhost SAN; an untrusted client is rejected');

    phase = 'grafana_settings';
    const settings = await api<Record<string, Record<string, string>>>('/api/admin/settings', 'GET', undefined, bootstrap);
    assert.equal(settings.status, 200);
    assert.equal(settings.body['auth.anonymous']?.enabled, 'false');
    assert.equal(settings.body.users?.allow_sign_up, 'false');
    assert.equal(settings.body.server?.protocol, 'https');
    assert.equal(settings.body.security?.cookie_secure, 'true');

    phase = 'grafana_users';
    const roles = new Map<string, string>();
    for (const role of ['Viewer', 'Admin']) {
      const login = `analytics-e2e-${role.toLowerCase()}`;
      const password = randomBytes(32).toString('hex');
      const created = await api<{ id: number }>('/api/admin/users', 'POST', { login, email: `${login}@example.invalid`, password }, bootstrap);
      assert.equal(created.status, 200);
      users.push(created.body.id);
      assert.equal((await api(`/api/org/users/${created.body.id}`, 'PATCH', { role }, bootstrap)).status, 200);
      roles.set(role, credentials(login, password));
    }
    const viewer = roles.get('Viewer')!;
    const admin = roles.get('Admin')!;
    const dashboard = { uid, title: 'Analytics E2E', schemaVersion: 39, panels: [], tags: ['e2e'] };
    const created = await api('/api/dashboards/db', 'POST', { dashboard }, admin);
    assert.equal(created.status, 200);
    dashboardCreated = true;
    phase = 'grafana_anonymous';
    assert.equal((await api(`/api/dashboards/uid/${uid}`)).status, 401);
    assert.equal((await api('/api/ds/query', 'POST', query)).status, 401);
    const signup = await api('/api/user/signup', 'POST', { email: 'blocked@example.invalid' });
    assert.equal(signup.status, 401);
    assert.equal(signup.body.message, 'User signup is disabled');
    phase = 'grafana_viewer';
    assert.equal((await api(`/api/dashboards/uid/${uid}`, 'GET', undefined, viewer)).status, 200);
    const changed = { dashboard: { ...dashboard, title: 'Analytics E2E updated' }, overwrite: true };
    assert.equal((await api('/api/dashboards/db', 'POST', changed, viewer)).status, 403);
    assert.equal((await api(`/api/dashboards/uid/${uid}`, 'DELETE', undefined, viewer)).status, 403);
    assert.equal((await api('/api/admin/settings', 'GET', undefined, viewer)).status, 403);
    phase = 'grafana_admin';
    assert.equal((await api('/api/dashboards/db', 'POST', changed, admin)).status, 200);
    const saved = await api<{ dashboard: { title: string } }>(`/api/dashboards/uid/${uid}`, 'GET', undefined, viewer);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.dashboard.title, changed.dashboard.title);

    phase = 'grafana_datasource';
    const result = await api<{ results: { A: { status: number; error?: string; frames: Array<{ data: { values: unknown[][] } }> } } }>('/api/ds/query', 'POST', query, viewer);
    assert.equal(result.status, 200);
    assert.equal(result.body.results.A.status, 200);
    assert.equal(result.body.results.A.error, undefined);
    assert.deepEqual(result.body.results.A.frames[0]?.data.values, [[3]]);
    console.log('Anonymous access and signup are denied; Viewer reads but cannot edit; Admin can edit');
    console.log('Real Grafana PostgreSQL datasource returned all three fixture observations over verified HTTPS');
    const events = await api<{ results: { A: { status: number; error?: string; frames: Array<{ data: { values: unknown[][] } }> } } }>('/api/ds/query', 'POST', {
      from: 'now-1h', to: 'now', queries: [{ refId: 'A', format: 'table', datasource: { uid: 'project-analytics', type: 'grafana-postgresql-datasource' }, rawSql: live.sql }],
    }, viewer);
    assert.equal(events.status, 200);
    assert.equal(events.body.results.A.status, 200);
    assert.equal(events.body.results.A.error, undefined);
    const eventValues = events.body.results.A.frames[0]?.data.values;
    assert.ok(eventValues);
    assert.deepEqual(eventValues.slice(0, 4), live.values.slice(0, 4));
    assert.deepEqual(eventValues[4]?.map(value => JSON.parse(String(value))), live.values[4]);
    console.log('Grafana returned the exact real GitHub delivery IDs and event identities verified in PostgreSQL');
  } finally {
    try {
      if (dashboardCreated) assert.equal((await api(`/api/dashboards/uid/${uid}`, 'DELETE', undefined, bootstrap)).status, 200);
    } finally {
      try {
        for (const id of users) assert.equal((await api(`/api/admin/users/${id}`, 'DELETE', undefined, bootstrap)).status, 200);
      } finally {
        trusted.destroy();
        untrusted.destroy();
      }
    }
  }
}

interface Fixture {

  marker: string;
  projectId: string;
  issueNumber: number;
  issueNodeId: string;
  itemId?: string;
  removed?: boolean;
}

async function save(fixture: Fixture): Promise<void> {
  await saveFixtureJournal(journal, fixture);
}

async function collect(): Promise<void> {
  const env = { ...process.env };
  delete env.FIXTURE_TOKEN;
  delete env.WEBHOOK_FORWARD_TOKEN;
  delete env.RAW_PRIVATE_KEY;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync(process.execPath, ['dist/analytics/main.js', '--once'], { env, encoding: 'utf8', timeout: 180_000 });
    if (result.status === 0) {
      console.log('Collector completed a full GitHub snapshot');
      return;
    }
    const diagnostic = result.stderr.split('\n').find(line => line.startsWith('{'));
    if (diagnostic) {
      const failure = JSON.parse(diagnostic) as { stage?: string; httpStatus?: number; reason?: string; details?: Record<string, unknown> };
      const transient = new Set(['Project changed during collection; retry with a fresh observation.',
        'Project changed while reading metadata.', 'Incomplete or changing connection.', 'Connection count or unique IDs do not match.']);
      // GitHub connection counts can lag mutations; other workflows also use this sandbox.
      // Every retry still requires a complete snapshot and preserves the collector's safety checks.
      if (attempt < 4 && failure.stage === 'project_snapshot' && transient.has(failure.reason ?? '')) {
        console.log(`Retrying inconsistent GitHub snapshot (${attempt + 1}/4)`);
        await delay(2000 * 2 ** attempt);
        continue;
      }
      console.error(JSON.stringify({ stage: failure.stage, httpStatus: failure.httpStatus, reason: failure.reason, details: failure.details }));
    }
    throw new Error(`Collector process failed with exit ${result.status ?? 'timeout'}`);
  }
}

async function verifyDatabaseRecovery(pool: pg.Pool, fixture: EventFixture): Promise<void> {
  const { itemId } = fixture;
  phase = 'database_restart';
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Database restart is restricted to the ephemeral CI stack');
  assert.equal(process.env.COMPOSE_PROJECT_NAME, `analytics-e2e-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  const before = await pool.query("SELECT count(*)::int AS completed FROM analytics.sync_runs WHERE status='complete'");
  const applicationName = 'analytics-e2e-recovery';
  const env: NodeJS.ProcessEnv = { ...process.env, SYNC_INTERVAL_SECONDS: '60', PGAPPNAME: applicationName };
  delete env.FIXTURE_TOKEN;
  delete env.WEBHOOK_FORWARD_TOKEN;
  delete env.RAW_PRIVATE_KEY;
  const collector = spawn(process.execPath, ['dist/analytics/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  const closed = new Promise<void>(resolve => {
    collector.once('error', () => { exited = true; resolve(); });
    collector.once('exit', () => { exited = true; resolve(); });
  });
  let completed = 0;
  let connectionFailed = false;
  let idleConnectionFailed = false;
  const readers = [collector.stdout, collector.stderr].map(input => {
    const reader = createInterface({ input });
    reader.on('line', line => {
      if (!line.startsWith('{')) return;
      try {
        const entry = JSON.parse(line) as { event?: string; stage?: string };
        if (entry.event === 'sync_complete') completed++;
        if (entry.event === 'sync_failed' && entry.stage === 'database_connect') connectionFailed = true;
        if (entry.event === 'database_idle_connection_failed') idleConnectionFailed = true;
      } catch { /* Raw collector output is never forwarded to CI logs. */ }
    });
    return reader;
  });
  async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      assert.equal(exited, false, 'The continuous collector must survive the database restart');
      if (await condition()) return;
      await delay(250);
    } while (Date.now() < deadline);
    assert.fail('Timed out waiting for database recovery');
  }
  function postgres(...args: string[]): void {
    const result = spawnSync('docker', ['compose', '--env-file', '.local/analytics.env',
      '-f', 'analytics/compose.yaml', '-f', 'analytics/compose.https.yaml', ...args, 'postgres'],
    { encoding: 'utf8', timeout: 120_000 });
    if (result.status !== 0) console.error(JSON.stringify({ event: 'postgres_lifecycle_failed', action: args[0],
      exitCode: result.status, unsupportedOption: /unknown flag|unknown shorthand flag|unknown command/.test(result.stderr ?? '') }));
    assert.equal(result.status, 0, 'Ephemeral PostgreSQL lifecycle command failed');
  }
  let events: Awaited<ReturnType<typeof startDatabaseFailureProbe>> | undefined;
  let stopped = false;
  try {
    events = await startDatabaseFailureProbe(pool, fixture);
    await waitFor(async () => {
      // PostgreSQL also reports idle while the collector holds its lock and awaits GitHub.
      const result = await pool.query(`SELECT 1 FROM pg_stat_activity a WHERE application_name=$1 AND state='idle'
        AND NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted)`, [applicationName]);
      return result.rowCount === 1;
    }, 10_000);
    console.log('Continuous collector connected; restarting only ephemeral PostgreSQL');
    stopped = true;
    postgres('stop', '--timeout', '1');
    await waitFor(() => idleConnectionFailed && connectionFailed, 90_000);
    console.log('The same collector survived an idle connection loss and a failed connection attempt');
    await events.assertUnavailable();
    phase = 'database_recovery';
    completed = 0;
    postgres('up', '-d', '--no-deps', '--no-recreate', '--wait', '--wait-timeout', '90');
    stopped = false;
    await events.assertRecovered();
    await waitFor(() => completed > 0, 180_000);
    const after = await pool.query("SELECT count(*)::int AS completed FROM analytics.sync_runs WHERE status='complete'");
    assert.ok(after.rows[0].completed > before.rows[0].completed);
    const fixtureState = await pool.query(`SELECT present,
      (SELECT count(*)::int FROM analytics.item_history WHERE item_id=$1) AS revisions
      FROM analytics.items WHERE item_id=$1`, [itemId]);
    assert.deepEqual(fixtureState.rows, [{ present: false, revisions: 3 }]);
    assert.equal(exited, false);
    console.log('The same collector committed a fresh full snapshot after PostgreSQL restart; fixture history is unchanged');
  } finally {
    if (!exited) {
      collector.kill('SIGTERM');
      const timeout = setTimeout(() => collector.kill('SIGKILL'), 10_000);
      try { await closed; } finally { clearTimeout(timeout); }
    }
    await events?.close();
    for (const reader of readers) reader.close();
    if (stopped) postgres('up', '-d', '--no-deps', '--no-recreate', '--wait', '--wait-timeout', '90');
  }
}

async function cleanup(): Promise<void> {
  phase = 'cleanup';
  const { attempt, finish } = cleanupAttempts();
  let fixture: Fixture | undefined;
  await attempt('base_journal', async () => {
    let saved: Fixture;
    try { saved = JSON.parse(await readFile(journal, 'utf8')) as Fixture; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    assert.equal(saved.marker, marker, 'Refusing to clean up another run');
    fixture = saved;
  });
  if (fixture) {
    const saved = fixture;
    await attempt('base_project_item', async () => {
      if (!saved.itemId || saved.removed) return;
      const result = await github.graphql<{ node: { project: { id: string }; content: { id: string } } | null }>(`
        query($id: ID!) { node(id: $id) { ... on ProjectV2Item { project { id } content { ... on Issue { id } } } } }
      `, { id: saved.itemId });
      if (result.node) {
        assert.equal(result.node.project.id, saved.projectId);
        assert.equal(result.node.content.id, saved.issueNodeId);
        await projects.deleteProjectItem(saved.projectId, saved.itemId);
      }
    });
    await attempt('base_issue_close', async () => {
      const issue = await github.rest.issues.get({ owner, repo, issue_number: saved.issueNumber });
      assert.equal(issue.data.node_id, saved.issueNodeId);
      assert.equal(issue.data.title, marker);
      assert.equal(issue.data.body, marker);
      await github.rest.issues.update({ owner, repo, issue_number: saved.issueNumber, state: 'closed' });
    });
  }
  await attempt('live_fixtures', () => cleanupLiveFixtures(github, projects, sandbox, marker));
  finish();
  console.log('This run’s GitHub fixtures and webhook cleaned up');
}

async function scenario(): Promise<void> {
  const status = await projects.getStatusMetadata(owner, projectNumber, 'Status');
  const iterations = await projects.getIterationMetadata(owner, projectNumber, 'Iteration');
  assert.equal(status.projectId, iterations.projectId);
  const options = [...status.optionIdsByName.entries()];
  assert.ok(options.length >= 2 && iterations.iterations.length >= 2, 'Sandbox needs two Status options and two Iterations');
  const [firstStatus, nextStatus] = [options[0]!, options[1]!];
  const [firstIteration, nextIteration] = [iterations.iterations[0]!, iterations.iterations[1]!];
  const issue = await github.rest.issues.create({ owner, repo, title: marker, body: marker });
  const fixture: Fixture = { marker, projectId: status.projectId, issueNumber: issue.data.number, issueNodeId: issue.data.node_id };
  await save(fixture);
  fixture.itemId = await projects.addIssueToProject(fixture.projectId, fixture.issueNodeId);
  await save(fixture);
  const itemId = fixture.itemId;
  const pool = new pg.Pool({

    host: process.env.PGHOST, port: Number(process.env.PGPORT), database: 'project_analytics', user: 'analytics_writer',
    password: (await readFile(process.env.PGPASSWORD_FILE!, 'utf8')).trim(), max: 1,
  });
  pool.on('error', () => { console.log('Fixture database connection closed; the next query will reconnect'); });
  async function assertCurrent(expectedStatus: string, expectedIteration: IterationDefinition, historyCount: number): Promise<void> {
    const result = await pool.query(`SELECT i.title, i.present, s.value->>'optionId' AS status_id,
      t.iteration_id, t.start_date::text, t.duration_days,
      (SELECT count(*)::int FROM analytics.item_history WHERE item_id=i.item_id) AS revisions
      FROM analytics.items i JOIN analytics.item_fields s ON s.item_id=i.item_id AND s.field_name='Status'
      JOIN analytics.item_iterations t ON t.item_id=i.item_id AND t.field_name='Iteration' WHERE i.item_id=$1`, [itemId]);
    assert.equal(result.rowCount, 1);
    assert.deepEqual(result.rows[0], { title: marker, present: true, status_id: expectedStatus,
      iteration_id: expectedIteration.id, start_date: expectedIteration.startDate, duration_days: expectedIteration.duration, revisions: historyCount });
  }
  try {
    await projects.setSingleSelect(fixture.projectId, itemId, status.statusFieldId, firstStatus[1]);
    await projects.setIteration(fixture.projectId, itemId, iterations.iterationFieldId, firstIteration.id);
    phase = 'initial_import';
    await collect();
    await assertCurrent(firstStatus[1], firstIteration, 1);
    phase = 'repeat_import';
    await collect();
    await assertCurrent(firstStatus[1], firstIteration, 1);
    console.log('Initial import and repeat import are correct and idempotent');

    phase = 'changed_import';
    await projects.setSingleSelect(fixture.projectId, itemId, status.statusFieldId, nextStatus[1]);
    await projects.setIteration(fixture.projectId, itemId, iterations.iterationFieldId, nextIteration.id);
    await collect();
    await assertCurrent(nextStatus[1], nextIteration, 2);
    const history = await pool.query(`SELECT snapshot->'fields' AS fields FROM analytics.item_history
      WHERE item_id=$1 AND kind='observed' ORDER BY revision`, [itemId]);
    assert.equal(history.rows[0].fields.find((field: { field: { name: string } }) => field.field.name === 'Iteration').iterationId, firstIteration.id);
    console.log('Changed Status and Iteration preserve the previous observation');

    phase = 'missing_import';
    await projects.deleteProjectItem(fixture.projectId, itemId);
    fixture.removed = true;
    await save(fixture);
    await collect();
    const missing = await pool.query(`SELECT present, missing_since IS NOT NULL AS marked FROM analytics.items WHERE item_id=$1`, [itemId]);
    assert.deepEqual(missing.rows, [{ present: false, marked: true }]);
    const kinds = await pool.query('SELECT kind FROM analytics.item_history WHERE item_id=$1 ORDER BY revision', [itemId]);
    assert.deepEqual(kinds.rows.map(row => row.kind), ['observed', 'observed', 'missing']);
    console.log('Full reconciliation marks the removed item without deleting history');

    const eventFixture: EventFixture = { target: { owner, number: projectNumber }, repositories: sandbox.repositories,
      projectId: fixture.projectId, itemId, contentId: fixture.issueNodeId };
    phase = 'webhook_redelivery';
    await verifyEventRedelivery(pool, eventFixture);
    await verifyDatabaseRecovery(pool, eventFixture);
    phase = 'live_github_webhooks';
    const live = await verifyLiveEvents(pool, github, projects, sandbox, marker);
    phase = 'grafana_query';
    await verifyGrafana({ from: 'now-1h', to: 'now', queries: [{ refId: 'A', format: 'table',
        datasource: { uid: 'project-analytics', type: 'grafana-postgresql-datasource' },
        rawSql: `SELECT count(*)::int AS revisions FROM analytics.item_history WHERE snapshot->'content'->>'title' = '${marker}'` }] }, live);
  } finally {
    await pool.end();
  }
}

try {
  if (process.argv[2] === 'cleanup') await cleanup();
  else await scenario();
} catch (error) {
  if (error instanceof assert.AssertionError) console.error(JSON.stringify({ event: 'analytics_e2e_assertion_failed', phase, operator: error.operator }));
  else console.error(JSON.stringify({ event: 'analytics_e2e_failed', phase, name: error instanceof Error ? error.name : 'UnknownError',
    httpStatus: typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined }));
  process.exitCode = 1;
}
