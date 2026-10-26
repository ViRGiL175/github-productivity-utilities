import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Octokit } from '@octokit/rest';
import pg from 'pg';
import { ProjectV2Repository, type IterationDefinition } from '../src/github/ProjectV2Repository.ts';
import { analyticsSandbox } from './analytics-sandbox.ts';

const sandbox = await analyticsSandbox();
const { owner, backlog: repo, number: projectNumber } = sandbox;
const journal = '.local/analytics-e2e-fixture.json';
const marker = `ITEST-analytics-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
assert.equal(process.env.PROJECT_OWNER, owner, 'E2E must target the existing sandbox');
assert.equal(process.env.PROJECT_NUMBER, String(projectNumber));
assert.ok(process.env.GITHUB_RUN_ID && process.env.FIXTURE_TOKEN, 'Run through the sandbox workflow');
assert.match(process.env.GITHUB_RUN_ID, /^\d+$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
const github = new Octokit({ auth: process.env.FIXTURE_TOKEN, request: { timeout: 30_000 }, log: { debug() {}, info() {}, warn() {}, error() {} } });
const projects = new ProjectV2Repository(github);

interface Fixture {

  marker: string;
  projectId: string;
  issueNumber: number;
  issueNodeId: string;
  itemId?: string;
  removed?: boolean;
}

async function save(fixture: Fixture): Promise<void> {
  await writeFile(journal, JSON.stringify(fixture), { mode: 0o600 });
}

async function collect(): Promise<void> {
  const env = { ...process.env };
  delete env.FIXTURE_TOKEN;
  delete env.RAW_PRIVATE_KEY;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = spawnSync(process.execPath, ['dist/analytics/main.js', '--once'], { env, encoding: 'utf8', timeout: 180_000 });
    if (result.status === 0) {
      console.log('Collector completed a full GitHub snapshot');
      return;
    }
    // Other existing workflows use this sandbox too; never edit or lock their fixtures.
    if (attempt < 3 && /Project changed (during collection|while reading metadata)/.test(result.stderr)) {
      await delay(2000);
      continue;
    }
    const diagnostic = result.stderr.split('\n').find(line => line.startsWith('{'));
    if (diagnostic) {
      const failure = JSON.parse(diagnostic) as { stage?: string; httpStatus?: number; reason?: string };
      console.error(JSON.stringify({ stage: failure.stage, httpStatus: failure.httpStatus, reason: failure.reason }));
    }
    throw new Error(`Collector process failed with exit ${result.status ?? 'timeout'}`);
  }
}

async function cleanup(): Promise<void> {
  let fixture: Fixture;
  try {
    fixture = JSON.parse(await readFile(journal, 'utf8')) as Fixture;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  assert.equal(fixture.marker, marker, 'Refusing to clean up another run');
  const issue = await github.rest.issues.get({ owner, repo, issue_number: fixture.issueNumber });
  assert.equal(issue.data.node_id, fixture.issueNodeId);
  assert.equal(issue.data.title, marker);
  assert.equal(issue.data.body, marker);
  if (fixture.itemId && !fixture.removed) {
    const result = await github.graphql<{ node: { project: { id: string }; content: { id: string } } | null }>(`
      query($id: ID!) { node(id: $id) { ... on ProjectV2Item { project { id } content { ... on Issue { id } } } } }
    `, { id: fixture.itemId });
    if (result.node) {
      assert.equal(result.node.project.id, fixture.projectId);
      assert.equal(result.node.content.id, fixture.issueNodeId);
      await projects.deleteProjectItem(fixture.projectId, fixture.itemId);
    }
  }
  await github.rest.issues.update({ owner, repo, issue_number: fixture.issueNumber, state: 'closed' });
  console.log('This run’s project item removed and issue closed');
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
    await collect();
    await assertCurrent(firstStatus[1], firstIteration, 1);
    await collect();
    await assertCurrent(firstStatus[1], firstIteration, 1);
    console.log('Initial import and repeat import are correct and idempotent');

    await projects.setSingleSelect(fixture.projectId, itemId, status.statusFieldId, nextStatus[1]);
    await projects.setIteration(fixture.projectId, itemId, iterations.iterationFieldId, nextIteration.id);
    await collect();
    await assertCurrent(nextStatus[1], nextIteration, 2);
    const history = await pool.query(`SELECT snapshot->'fields' AS fields FROM analytics.item_history
      WHERE item_id=$1 AND kind='observed' ORDER BY revision`, [itemId]);
    assert.equal(history.rows[0].fields.find((field: { field: { name: string } }) => field.field.name === 'Iteration').iterationId, firstIteration.id);
    console.log('Changed Status and Iteration preserve the previous observation');

    await projects.deleteProjectItem(fixture.projectId, itemId);
    fixture.removed = true;
    await save(fixture);
    await collect();
    const missing = await pool.query(`SELECT present, missing_since IS NOT NULL AS marked FROM analytics.items WHERE item_id=$1`, [itemId]);
    assert.deepEqual(missing.rows, [{ present: false, marked: true }]);
    const kinds = await pool.query('SELECT kind FROM analytics.item_history WHERE item_id=$1 ORDER BY revision', [itemId]);
    assert.deepEqual(kinds.rows.map(row => row.kind), ['observed', 'observed', 'missing']);
    console.log('Full reconciliation marks the removed item without deleting history');

    const password = (await readFile('.local/secrets/grafana-admin', 'utf8')).trim();
    const response = await fetch('http://127.0.0.1:3301/api/ds/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`localadmin:${password}`).toString('base64')}` },
      body: JSON.stringify({ from: 'now-1h', to: 'now', queries: [{ refId: 'A', format: 'table',
        datasource: { uid: 'project-analytics', type: 'grafana-postgresql-datasource' },
        rawSql: `SELECT count(*)::int AS revisions FROM analytics.item_history WHERE snapshot->'content'->>'title' = '${marker}'` }] }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, 'Grafana datasource query must succeed');
    const result = await response.json() as { results: { A: { status: number; error?: string; frames: Array<{ data: { values: unknown[][] } }> } } };
    assert.equal(result.results.A.status, 200);
    assert.equal(result.results.A.error, undefined);
    assert.deepEqual(result.results.A.frames[0]?.data.values, [[3]]);
    console.log('Real Grafana PostgreSQL datasource returned all three fixture observations');
  } finally {
    await pool.end();
  }
}

try {
  if (process.argv[2] === 'cleanup') await cleanup();
  else await scenario();
} catch (error) {
  if (error instanceof assert.AssertionError) console.error(`E2E assertion failed: ${error.message}`);
  else console.error(JSON.stringify({ event: 'analytics_e2e_failed', name: error instanceof Error ? error.name : 'UnknownError',
    httpStatus: typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined }));
  process.exitCode = 1;
}
