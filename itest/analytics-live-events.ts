import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { open, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Octokit } from '@octokit/rest';
import type { Pool } from 'pg';
import { PostgresEventStore } from '../src/analytics/PostgresEventStore.ts';
import { webhookServer } from '../src/analytics/webhooks.ts';
import type { ProjectV2Repository } from '../src/github/ProjectV2Repository.ts';
import { analyticsSandbox } from './analytics-sandbox.ts';
import { cleanupAttempts, saveFixtureJournal } from './analytics-fixture-state.ts';

const journal = '.local/analytics-live-fixtures.json';
type Sandbox = Awaited<ReturnType<typeof analyticsSandbox>>;
interface Issue {

  id: string;
  databaseId: number;
  number: number;
  repo: string;
  deleted?: boolean;
}
interface Fixtures {

  marker: string;
  projectId: string;
  issues: Issue[];
  items: string[];
  hookId?: number;
}
interface EventRow {

  delivery_id: string;
  event_name: string;
  action: string;
  content_id: string;
  item_id: string | null;
  data: Record<string, any>;
}
export interface LiveEventQuery {

  sql: string;
  values: unknown[][];
}
const save = (fixtures: Fixtures) => saveFixtureJournal(journal, fixtures);

function receiptPath(marker: string): string {
  assert.match(marker, /^ITEST-analytics-\d+-\d+$/);
  return `.local/secrets/analytics-forwarder-${marker}.log`;
}

async function forwarderHookId(owner: string, marker: string): Promise<number | undefined> {
  let receipt: string;
  try { receipt = await readFile(receiptPath(marker), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  // gh-webhook v0.2.0 has no hook-ID output flag. Its private API response log
  // identifies our creation even if the WebSocket connection/activation fails.
  const ids = new Set<number>();
  let json = '';
  for (const line of receipt.split('\n')) {
    if (!json && !line.startsWith('{')) continue;
    json += line + '\n';
    let value;
    try { value = JSON.parse(json); } catch { continue; }
    json = '';
    if (value.name === 'cli' && Number.isSafeInteger(value.id) && value.id > 0 &&
        value.url === `https://api.github.com/orgs/${owner}/hooks/${value.id}`) ids.add(value.id);
  }
  assert.ok(ids.size <= 1, 'Ambiguous forwarder receipt; refusing to guess webhook ownership');
  return [...ids][0];
}

async function removeForwarderHook(hooks: Octokit, owner: string, marker: string, fixtures?: Fixtures): Promise<void> {
  const receivedId = await forwarderHookId(owner, marker);
  if (receivedId && fixtures?.hookId) assert.equal(receivedId, fixtures.hookId);
  const id = receivedId ?? fixtures?.hookId;
  if (!id) {
    let receipt: string;
    try { receipt = await readFile(receiptPath(marker), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    assert.ok(/HTTP\/[\d.]+ 4\d\d\b/.test(receipt), 'Webhook creation outcome unknown; no owned hook ID was received');
    return;
  }
  try {
    const hook = await hooks.rest.orgs.getWebhook({ org: owner, hook_id: id });
    assert.equal(hook.data.name, 'cli');
    await hooks.rest.orgs.deleteWebhook({ org: owner, hook_id: id });
  } catch (error) { if (!(typeof error === 'object' && error !== null && 'status' in error && error.status === 404)) throw error; }
  if (fixtures) { delete fixtures.hookId; await save(fixtures); }
  console.log('This run’s GitHub CLI webhook is absent');
}

export async function cleanupLiveFixtures(github: Octokit, projects: ProjectV2Repository, sandbox: Sandbox, marker: string): Promise<void> {
  const { attempt, finish } = cleanupAttempts();
  let loaded: Fixtures | undefined;
  await attempt('live_journal', async () => {
    let saved: Fixtures;
    try { saved = JSON.parse(await readFile(journal, 'utf8')) as Fixtures; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    assert.equal(saved.marker, marker, 'Refusing to clean another run');
    loaded = saved;
  });
  const hooks = new Octokit({ auth: process.env.WEBHOOK_FORWARD_TOKEN, request: { timeout: 30_000 }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  await attempt('webhook', () => removeForwarderHook(hooks, sandbox.owner, marker, loaded));
  if (!loaded) { finish(); return; }
  const fixtures = loaded;
  const readableRepositories = new Set<string>();
  // Recover successful creations whose response or journal write was interrupted.
  for (const repo of sandbox.repositories) await attempt('issue_recovery', async () => {
    for await (const page of github.paginate.iterator(github.rest.issues.listForRepo, { owner: sandbox.owner, repo, state: 'all', per_page: 100 })) {
      for (const issue of page.data) {
        if (issue.pull_request || !issue.title.startsWith(marker + '-') || !issue.body?.includes(marker)) continue;
        if (!fixtures.issues.some(saved => saved.id === issue.node_id)) fixtures.issues.push({ id: issue.node_id, databaseId: issue.id, number: issue.number, repo });
      }
    }
    readableRepositories.add(repo);
    await save(fixtures);
  });
  await attempt('project_items', async () => {
    const project = await projects.getIterationMetadata(sandbox.owner, sandbox.number, 'Iteration');
    assert.equal(fixtures.projectId, project.projectId);
    const items = (await projects.listProjectItems(project.projectId, project.iterationFieldId)).filter(item => item.title.startsWith(marker + '-'));
    for (const item of items) await attempt('project_item', async () => {
      if (item.contentType === 'Issue') {
        const result = await github.graphql<{ node: { id: string; databaseId: number; title: string; body: string; number: number; repository: { name: string; owner: { login: string } } } }>(
          'query($id:ID!) { node(id:$id) { ... on Issue { id databaseId title body number repository { name owner { login } } } } }', { id: item.contentId });
        const issue = result.node;
        assert.ok(issue.title.startsWith(marker + '-') && issue.body.includes(marker));
        assert.equal(issue.repository.owner.login.toLowerCase(), sandbox.owner.toLowerCase());
        assert.ok(sandbox.repositories.includes(issue.repository.name));
        if (!fixtures.issues.some(saved => saved.id === issue.id)) {
          fixtures.issues.push({ id: issue.id, databaseId: issue.databaseId, number: issue.number, repo: issue.repository.name });
          await save(fixtures);
        }
      } else assert.equal(item.contentType, 'DraftIssue');
      await projects.deleteProjectItem(fixtures.projectId, item.id);
      fixtures.items = fixtures.items.filter(id => id !== item.id); await save(fixtures);
    });
  });
  for (const issue of fixtures.issues) {
    if (issue.deleted) continue;
    await attempt('issue_close', async () => {
      let result;
      try { result = await github.rest.issues.get({ owner: sandbox.owner, repo: issue.repo, issue_number: issue.number }); }
      catch (error) {
        if (readableRepositories.has(issue.repo) && typeof error === 'object' && error !== null && 'status' in error && error.status === 404) return;
        throw error;
      }
      assert.ok(result.data.title.startsWith(marker + '-') && result.data.body?.includes(marker));
      // A transfer changes the node ID; the destination was recovered by its run marker above.
      if (result.data.node_id !== issue.id) return;
      await github.rest.issues.update({ owner: sandbox.owner, repo: issue.repo, issue_number: issue.number, state: 'closed' });
    });
  }
  finish();
}

export async function verifyLiveEvents(pool: Pool, github: Octokit, projects: ProjectV2Repository, sandbox: Sandbox, marker: string): Promise<LiveEventQuery> {
  const { owner, backlog: repo, number } = sandbox;
  assert.ok(process.env.WEBHOOK_FORWARD_TOKEN, 'Missing sandbox webhook credential');
  const sandboxOwner = new Octokit({ auth: process.env.WEBHOOK_FORWARD_TOKEN, request: { timeout: 30_000 }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  const existing = await sandboxOwner.paginate(sandboxOwner.rest.orgs.listWebhooks, { org: owner });
  assert.equal(existing.some(hook => hook.name === 'cli'), false, 'Another sandbox GitHub CLI forwarder is running');
  const status = await projects.getStatusMetadata(owner, number, 'Status');
  const priority = await projects.getStatusMetadata(owner, number, 'Priority');
  const iteration = await projects.getIterationMetadata(owner, number, 'Iteration');
  const fields = await github.graphql<{ node: { fields: { nodes: Array<{ id?: string; name?: string; dataType?: string }> } } }>(`
    query($id:ID!) { node(id:$id) { ... on ProjectV2 { fields(first:100) { nodes { ... on ProjectV2Field { id name dataType } } } } } }`, { id: status.projectId });
  const estimate = fields.node.fields.nodes.find(field => field.dataType === 'NUMBER');
  assert.ok(estimate?.id, 'Sandbox needs a number field');
  assert.ok(iteration.iterations.length >= 2);
  const fixtures: Fixtures = { marker, projectId: status.projectId, issues: [], items: [] };
  await save(fixtures);
  const secret = randomBytes(32).toString('hex');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${secret}`);
  const server = webhookServer(secret, new PostgresEventStore(pool, { owner, number }, sandbox.repositories));
  let ready = false;
  server.on('request', (request, response) => {
    if (request.headers['x-github-event'] === 'ping') response.on('finish', () => { if (response.statusCode === 204) ready = true; });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/github/webhooks`;
  // GitHub's development forwarder preserves the original payload, signature and delivery ID.
  // Never omit --url: the CLI otherwise writes complete webhook payloads to stdout.
  // Keep the CLI's API diagnostics private: they may contain the temporary secret.
  // Passing the descriptor directly also preserves the creation response if Node exits.
  const receipt = await open(receiptPath(marker), 'wx', 0o600).catch(async error => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  });
  const forwarder = spawn('gh', ['webhook', 'forward', '--org', owner, '--events', 'projects_v2_item,issues,sub_issues', '--url', url, '--secret', secret],
    { env: { ...process.env, GH_TOKEN: process.env.WEBHOOK_FORWARD_TOKEN, GH_DEBUG: 'api', NO_COLOR: '1' },
      stdio: ['ignore', 'ignore', receipt.fd], windowsHide: true, detached: process.platform !== 'win32' });
  let exited = false;
  const closed = new Promise<void>(resolve => {
    forwarder.once('error', () => { exited = true; resolve(); });
    forwarder.once('close', () => { exited = true; resolve(); });
  });
  const verified: EventRow[] = [];
  let phase = 'signed_github_ping';
  async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 90_000;
    do {
      assert.equal(exited, false, `GitHub forwarder exited during ${phase}; check sandbox webhook permission`);
      const value = await read();
      if (value !== undefined) return value;
      await delay(500);
    } while (Date.now() < deadline);
    throw new Error(`No real GitHub event observed during ${phase}`);
  }
  async function mutation(name: string, event: string, action: string, change: () => Promise<unknown>, matches: (row: EventRow) => boolean): Promise<EventRow> {
    phase = name;
    const before = (await pool.query('SELECT coalesce(max(revision),0)::text AS revision FROM analytics.project_events')).rows[0].revision;
    await change();
    const row = await waitFor(async () => {
      const result = await pool.query<EventRow>(`SELECT delivery_id,event_name,action,content_id,item_id,data FROM analytics.project_events
        WHERE revision > $1 AND event_name=$2 AND action=$3 ORDER BY revision`, [before, event, action]);
      return result.rows.find(matches);
    });
    assert.equal(JSON.stringify(row.data).includes(marker), false, 'Journal must not retain fixture title or body');
    verified.push(row);
    console.log(`Real GitHub event verified: ${name}`);
    return row;
  }
  async function createIssue(suffix: string): Promise<Issue> {
    const created = await github.rest.issues.create({ owner, repo, title: `${marker}-${suffix}`, body: `${marker}-private-body` });
    const issue = { id: created.data.node_id, databaseId: created.data.id, number: created.data.number, repo };
    fixtures.issues.push(issue); await save(fixtures); return issue;
  }
  async function add(issue: Issue): Promise<string> {
    const id = await projects.addIssueToProject(fixtures.projectId, issue.id);
    fixtures.items.push(id); await save(fixtures); return id;
  }
  async function remove(itemId: string): Promise<void> {
    await projects.deleteProjectItem(fixtures.projectId, itemId);
    fixtures.items = fixtures.items.filter(id => id !== itemId); await save(fixtures);
  }
  const graphqlMutation = (operation: string, type: string, input: unknown) => github.graphql(
    `mutation($input:${type}!) { ${operation}(input:$input) { clientMutationId } }`, { input });
  try {
    const hookId = await waitFor(() => forwarderHookId(owner, marker));
    fixtures.hookId = hookId; await save(fixtures);
    const hook = await waitFor(async () => {
      const result = await sandboxOwner.rest.orgs.getWebhook({ org: owner, hook_id: hookId });
      return result.data.active ? result.data : undefined;
    });
    await sandboxOwner.rest.orgs.pingWebhook({ org: owner, hook_id: hook.id });
    await waitFor(async () => ready ? true : undefined);
    let parent!: Issue;
    await mutation('issue_opened', 'issues', 'opened', async () => { parent = await createIssue('parent'); }, row => row.content_id === parent.id && row.data.state === 'open');
    const child = await createIssue('child');
    let itemId!: string;
    await mutation('project_created', 'projects_v2_item', 'created', async () => { itemId = await add(parent); }, row => row.content_id === parent.id && row.data.present === true);
    await add(child);
    const editField = (fieldId: string, value: unknown) => graphqlMutation('updateProjectV2ItemFieldValue', 'UpdateProjectV2ItemFieldValueInput', { projectId: fixtures.projectId, itemId, fieldId, value });
    const clearField = (fieldId: string) => graphqlMutation('clearProjectV2ItemFieldValue', 'ClearProjectV2ItemFieldValueInput', { projectId: fixtures.projectId, itemId, fieldId });
    const fieldMatch = (fieldId: string, to: unknown) => (row: EventRow) => row.content_id === parent.id && row.data.field?.field_node_id === fieldId && JSON.stringify(row.data.field.to) === JSON.stringify(to);
    for (const [from, value] of [[null, 8], [8, 0]]) { const row = await mutation(`estimate_${value}`, 'projects_v2_item', 'edited', () => editField(estimate.id!, { number: value }), fieldMatch(estimate.id!, value)); assert.equal(from === null ? row.data.field.from : Number(row.data.field.from), from); }
    async function cleared(label: string, fieldId: string, fieldName: string): Promise<void> {
      await mutation(label, 'projects_v2_item', 'edited', () => clearField(fieldId), row => row.content_id === parent.id && row.data.field?.field_node_id === fieldId &&
        (!Object.hasOwn(row.data.field, 'to') || row.data.field.to === null));
      const current = await github.graphql<{ node: { fieldValueByName: unknown } }>(        'query($id:ID!,$name:String!) { node(id:$id) { ... on ProjectV2Item { fieldValueByName(name:$name) { ... on ProjectV2ItemFieldNumberValue { number } ... on ProjectV2ItemFieldSingleSelectValue { name } ... on ProjectV2ItemFieldIterationValue { iterationId } } } } }', { id: itemId, name: fieldName });
      assert.equal(current.node.fieldValueByName, null, 'GitHub must confirm the field was cleared even when its webhook omits endpoints');
    }
    await cleared('estimate_cleared', estimate.id!, estimate.name!);
    for (const [label, metadata] of [['status', status], ['focus_contract', priority]] as const) {
      const options = [...metadata.optionIdsByName.entries()];
      assert.ok(options.length >= 2);
      await clearField(metadata.statusFieldId);
      let previous: string | null = null;
      for (const [name, id] of options.slice(0, 2)) { const row = await mutation(`${label}_changed`, 'projects_v2_item', 'edited',
        () => editField(metadata.statusFieldId, { singleSelectOptionId: id }), row => row.content_id === parent.id && row.data.field?.field_node_id === metadata.statusFieldId && row.data.field.to?.id === id && row.data.field.to?.name === name);
        assert.equal(row.data.field.from?.id ?? null, previous); previous = id;
      }
      await cleared(`${label}_cleared`, metadata.statusFieldId, label === 'status' ? 'Status' : 'Priority');
    }
    let previousIteration: Record<string, string | number> | null = null;
    for (const value of iteration.iterations.slice(0, 2)) {
      const row = await mutation('iteration_changed', 'projects_v2_item', 'edited',
        () => editField(iteration.iterationFieldId, { iterationId: value.id }), row => row.content_id === parent.id && row.data.field?.field_node_id === iteration.iterationFieldId && row.data.field.to?.id === value.id);
      assert.deepEqual(row.data.field.from, previousIteration);
      const expected = { id: value.id, title: value.title, start_date: value.startDate, duration: value.duration };
      assert.deepEqual(row.data.field.to, expected);
      previousIteration = expected;
    }
    await cleared('iteration_cleared', iteration.iterationFieldId, 'Iteration');
    await mutation('issue_edited', 'issues', 'edited', () => github.rest.issues.update({ owner, repo, issue_number: parent.number, body: `${marker}-changed-private-body` }), row => row.content_id === parent.id);
    for (const reason of ['completed', 'not_planned'] as const) {
      await mutation(`closed_${reason}`, 'issues', 'closed', () => github.rest.issues.update({ owner, repo, issue_number: parent.number, state: 'closed', state_reason: reason }),
        row => row.content_id === parent.id && row.data.state === 'closed' && row.data.state_reason === reason && typeof row.data.closed_at === 'string');
      await mutation('issue_reopened', 'issues', 'reopened', () => github.rest.issues.update({ owner, repo, issue_number: parent.number, state: 'open', state_reason: 'reopened' }), row => row.content_id === parent.id && row.data.state === 'open' && row.data.closed_at === null);
    }
    for (const linked of [true, false]) { await mutation(linked ? 'child_linked' : 'child_unlinked', 'sub_issues', linked ? 'sub_issue_added' : 'sub_issue_removed',
      () => (linked ? github.rest.issues.addSubIssue : github.rest.issues.removeSubIssue)({ owner, repo, issue_number: parent.number, sub_issue_id: child.databaseId }),
      row => row.content_id === child.id && row.data.linked === linked && (row.data.parent_id === parent.id || row.data.parent_database_id === parent.databaseId));
      const counterpart = await waitFor(async () => (await pool.query<EventRow>(
        'SELECT delivery_id,event_name,action,content_id,item_id,data FROM analytics.project_events WHERE event_name=$1 AND action=$2 AND content_id=$3 ORDER BY revision DESC',
        ['sub_issues', linked ? 'parent_issue_added' : 'parent_issue_removed', child.id])).rows.find(row => row.data.linked === linked && (row.data.parent_id === parent.id || row.data.parent_database_id === parent.databaseId)));
      verified.push(counterpart);
    }
    for (const archived of [true, false]) await mutation(archived ? 'project_archived' : 'project_restored', 'projects_v2_item', archived ? 'archived' : 'restored',
      () => graphqlMutation(archived ? 'archiveProjectV2Item' : 'unarchiveProjectV2Item', archived ? 'ArchiveProjectV2ItemInput' : 'UnarchiveProjectV2ItemInput', { projectId: fixtures.projectId, itemId }),
      row => row.content_id === parent.id && row.data.archived === archived);
    await mutation('project_deleted', 'projects_v2_item', 'deleted', () => remove(itemId), row => row.content_id === parent.id && row.data.present === false);
    await mutation('project_readded', 'projects_v2_item', 'created', async () => { itemId = await add(parent); }, row => row.content_id === parent.id && row.data.present === true);
    const draft = await github.graphql<{ addProjectV2DraftIssue: { projectItem: { id: string; content: { id: string } } } }>(`
      mutation($input:AddProjectV2DraftIssueInput!) { addProjectV2DraftIssue(input:$input) { projectItem { id content { ... on DraftIssue { id } } } } }`,
      { input: { projectId: fixtures.projectId, title: `${marker}-draft`, body: `${marker}-draft-private-body` } });
    const draftItem = draft.addProjectV2DraftIssue.projectItem;
    fixtures.items.push(draftItem.id); await save(fixtures);
    const repository = await github.rest.repos.get({ owner, repo });
    let converted!: Issue;
    await mutation('draft_converted', 'projects_v2_item', 'converted', async () => {
      const result = await github.graphql<{ convertProjectV2DraftIssueItemToIssue: { item: { content: { id: string; databaseId: number; number: number } } } }>(`
        mutation($input:ConvertProjectV2DraftIssueItemToIssueInput!) { convertProjectV2DraftIssueItemToIssue(input:$input) { item { content { ... on Issue { id databaseId number } } } } }`,
        { input: { itemId: draftItem.id, repositoryId: repository.data.node_id } });
      converted = { ...result.convertProjectV2DraftIssueItemToIssue.item.content, repo };
      fixtures.issues.push(converted); await save(fixtures);
    }, row => row.item_id === draftItem.id && row.content_id === converted.id && row.data.content_type_change?.from === 'DraftIssue' && row.data.content_type_change?.to === 'Issue');
    const transfer = await createIssue('transfer');
    const destination = sandbox.repositories.find(name => name !== repo);
    assert.ok(destination);
    const destinationRepo = await github.rest.repos.get({ owner, repo: destination });
    const sourceIssueId = transfer.id;
    // Lifecycle mutations use the existing sandbox owner PAT; the fixture App keeps its limited permissions.
    await mutation('issue_transferred', 'issues', 'transferred', async () => {
      const result = await sandboxOwner.graphql<{ transferIssue: { issue: { id: string; databaseId: number; number: number } } }>(`
        mutation($input:TransferIssueInput!) { transferIssue(input:$input) { issue { id databaseId number } } }`, { input: { issueId: transfer.id, repositoryId: destinationRepo.data.node_id } });
      Object.assign(transfer, result.transferIssue.issue, { repo: destination }); await save(fixtures);
    }, row => row.content_id === sourceIssueId);
    const disposable = await createIssue('delete');
    await mutation('issue_deleted', 'issues', 'deleted', async () => {
      await sandboxOwner.graphql('mutation($input:DeleteIssueInput!) { deleteIssue(input:$input) { clientMutationId } }',
        { input: { issueId: disposable.id } });
      disposable.deleted = true; await save(fixtures);
    }, row => row.content_id === disposable.id);
    verified.sort((a, b) => a.delivery_id.localeCompare(b.delivery_id));
    for (const row of verified) assert.match(row.delivery_id, /^[a-f0-9-]{36}$/i);
    return {
      sql: `SELECT delivery_id::text,event_name,action,content_id,data::text FROM analytics.project_events WHERE delivery_id IN (${verified.map(row => `'${row.delivery_id}'`).join(',')}) ORDER BY delivery_id::text`,
      values: ['delivery_id', 'event_name', 'action', 'content_id', 'data'].map(key => verified.map(row => row[key as keyof EventRow])),
    };
  } catch (error) {
    const graphqlErrorTypes = typeof error === 'object' && error !== null && 'errors' in error && Array.isArray(error.errors)
      ? error.errors.map(item => typeof item?.type === 'string' && /^[A-Z_]+$/.test(item.type) ? item.type : 'UNKNOWN') : undefined;
    console.error(JSON.stringify({ event: 'live_webhook_scenario_failed', phase, graphqlErrorTypes,
      httpStatus: typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined }));
    throw error;
  } finally {
    const { attempt, finish } = cleanupAttempts();
    // Stop the creator before reading its final receipt: it must not create a hook
    // after cleanup has decided there is nothing to remove.
    await attempt('forwarder_stop', async () => {
      if (!exited && forwarder.pid) {
        if (process.platform === 'win32') {
          const result = spawnSync('taskkill', ['/PID', String(forwarder.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          assert.equal(result.status, 0);
        } else process.kill(-forwarder.pid, 'SIGTERM');
      }
      await Promise.race([closed, delay(5000)]);
      if (!exited && forwarder.pid && process.platform !== 'win32') {
        process.kill(-forwarder.pid, 'SIGKILL');
        await Promise.race([closed, delay(5000)]);
      }
      assert.equal(exited, true, 'Forwarder did not stop');
    });
    await attempt('forwarder_receipt', async () => { try { await receipt.sync(); } finally { await receipt.close(); } });
    await attempt('webhook', () => removeForwarderHook(sandboxOwner, owner, marker, fixtures));
    await attempt('webhook_server', () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    finish();
  }
}
