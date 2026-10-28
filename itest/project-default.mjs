import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectV2Repository } from '../src/github/ProjectV2Repository.ts';

// Manual precondition: use IAB to set Inbox as Default on this sandbox field.
// Public GraphQL does not expose that setting. Never write Horizon in this test.
const owner = 'ViRGiL-GH-Productivity';
const projectId = 'PVT_kwDOD_pocM4BRshl';
const fieldName = 'Horizon diagnostic 2026-10-28';

export async function run({ github, context, core }) {
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT || '1');
  const result = { runId: context.runId, attempt, projectId, fieldName, entities: [], samples: [], cleanup: [] };
  const save = () => writeFile('project-default-result.json', JSON.stringify(result, null, 2));
  const projects = new ProjectV2Repository(github);
  const suffix = `${context.runId}-${attempt}`;
  const branch = `gff-horizon-default-${suffix}`;
  let issue;
  let pr;
  let failure;

  async function sample(phase) {
    for (const entity of result.entities.filter(item => item.itemId)) {
      const data = await github.graphql(`query($id: ID!, $name: String!) {
        node(id: $id) { ... on ProjectV2Item {
          id fieldValueByName(name: $name) { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }
        } }
      }`, { id: entity.itemId, name: fieldName });
      assert(data.node, `Project item disappeared: ${entity.itemId}`);
      const observation = { phase, at: new Date().toISOString(), kind: entity.kind, itemId: entity.itemId, value: data.node.fieldValueByName ?? null };
      result.samples.push(observation);
      core.info(JSON.stringify(observation));
      await save();
    }
  }

  try {
    const metadata = await github.graphql(`query($id: ID!) { node(id: $id) { ... on ProjectV2 {
      id fields(first:100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
    } } }`, { id: projectId });
    const field = metadata.node?.fields.nodes.find(value => value?.name === fieldName);
    assert(field, `Missing sandbox project single-select: ${fieldName}`);
    assert(field.options.some(option => option.name === 'Inbox'), 'Missing Inbox option');
    result.field = field;
    await save();

    issue = (await github.rest.issues.create({ owner, repo: 'scrum-test-backlog',
      title: `ITEST Horizon default ${suffix} issue`, body: 'Isolated App/GraphQL default diagnostic. Retain project item as evidence; closed after observation.' })).data;
    result.entities.push({ kind: 'Issue', number: issue.number, nodeId: issue.node_id, url: issue.html_url });
    await save();
    const base = await github.rest.git.getRef({ owner, repo: 'test-client', ref: 'heads/main' });
    await github.rest.git.createRef({ owner, repo: 'test-client', ref: `refs/heads/${branch}`, sha: base.data.object.sha });
    result.branch = branch;
    await save();
    await github.rest.repos.createOrUpdateFileContents({ owner, repo: 'test-client', branch,
      path: `itest/horizon-default-${suffix}.txt`, message: 'Add isolated project-default diagnostic fixture',
      content: Buffer.from('Diagnostic fixture. Do not merge.\n').toString('base64') });
    pr = (await github.rest.pulls.create({ owner, repo: 'test-client', head: branch, base: 'main', draft: true,
      title: `ITEST Horizon default ${suffix} PR`,
      body: '## Why\nObserve project defaults through the existing App.\n\n## Changes\nOne diagnostic fixture; do not merge.\n\n## Validation\nRead Horizon after addProjectV2ItemById without writing the field.' })).data;
    result.entities.push({ kind: 'PullRequest', number: pr.number, nodeId: pr.node_id, url: pr.html_url });
    await save();
    for (const entity of result.entities) {
      // This is the production repository adapter's actual addProjectV2ItemById path.
      entity.itemId = await projects.addContentToProject(projectId, entity.nodeId);
      entity.addedAt = new Date().toISOString();
      await save();
      await sample(`immediate-after-${entity.kind}`);
    }
    await delay(30_000);
    await sample('after-30s');
    await delay(90_000);
    await sample('after-120s');
    for (const entity of result.entities) {
      const final = result.samples.find(value => value.phase === 'after-120s' && value.itemId === entity.itemId);
      assert.equal(final?.value?.name, 'Inbox', `${entity.kind}: expected default Inbox after 120 seconds`);
    }
  } catch (error) {
    failure = error;
    result.error = error.message;
  } finally {
    // Only close fixtures created by this run. Preserve items, field values and branch.
    for (const [kind, entity, repo] of [['Issue', issue, 'scrum-test-backlog'], ['PullRequest', pr, 'test-client']]) {
      if (!entity) continue;
      try {
        await github.rest.issues.update({ owner, repo, issue_number: entity.number, state: 'closed' });
        result.cleanup.push({ kind, number: entity.number, state: 'closed' });
      } catch (error) {
        result.cleanup.push({ kind, number: entity.number, error: error.message });
        failure ??= error;
      }
    }
    result.finishedAt = new Date().toISOString();
    result.passed = !failure;
    await save();
    await core.summary.addHeading('App / addProjectV2ItemById default experiment')
      .addRaw(`Project single-select: ${fieldName}. Default Inbox prepared manually in IAB; no Horizon assignment in test.\n\n`)
      .addTable([['Type', 'Phase', 'Observed value', 'UTC'], ...result.samples.map(value => [value.kind, value.phase, value.value?.name ?? '(empty)', value.at])])
      .addRaw(result.entities.map(entity => `${entity.kind}: ${entity.url}`).join('\n\n'))
      .addRaw(`\n\nResult: ${result.passed ? 'PASS' : 'FAIL'}. Fixtures closed; project items and branch retained.\n`).write();
  }
  if (failure) throw failure;
}
