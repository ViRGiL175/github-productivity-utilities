import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import type { IntegrationCore } from './runtime.ts';
import { ensureNextIterationReminder } from '../src/automations/ensure-next-iteration-reminder/EnsureNextIterationReminder.ts';
import { ProjectV2Repository } from '../src/github/ProjectV2Repository.ts';

// One live scenario, using the same PAT/App sandbox as the other reminder tests.
export async function run(github: Octokit, core: IntegrationCore): Promise<void> {
  const owner = process.env.PROJECT_OWNER;
  assert(owner, 'PROJECT_OWNER is required');
  const number = Number(process.env.PROJECT_NUMBER);
  const repo = process.env.AUTH_MODE === 'app' ? 'scrum-test-backlog' : 'github-productivity-utilities';
  const suffix = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const fieldName = `ITEST-${suffix}-iteration`;
  const reminderTitle = `ITEST-${suffix}-new-iteration-reminder`;
  const projects = new ProjectV2Repository(github);
  const sandbox = await projects.getIterationMetadata(owner, number, 'Iteration');
  const today = new Date().toISOString().slice(0, 10);
  const oldStart = new Date(`${today}T00:00:00Z`);
  oldStart.setUTCDate(oldStart.getUTCDate() - 14);
  let fieldId: string | undefined;
  const issues: number[] = [];
  const itemIds: string[] = [];
  try {
    const created = await github.graphql<{ createProjectV2Field: { projectV2Field: { id: string } } }>(`mutation($input: CreateProjectV2FieldInput!) {
      createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2IterationField { id } } }
    }`, { input: {
      projectId: sandbox.projectId, dataType: 'ITERATION', name: fieldName,
      iterationConfiguration: {
        duration: 7, startDate: oldStart.toISOString().slice(0, 10),
        iterations: [
          { title: 'Sprint 41', startDate: oldStart.toISOString().slice(0, 10), duration: 7 },
          { title: 'Sprint 42', startDate: today, duration: 7 },
        ],
      },
    } });
    fieldId = created.createProjectV2Field.projectV2Field.id;
    const before = await projects.getIterationMetadata(owner, number, fieldName);
    assert.equal(before.iterations.length, 2);
    // Prove that preservation exercises completedIterations as well as active iterations.
    const completed = await github.graphql<{ node: { configuration: { completedIterations: { id: string }[] } } }>(`query($id: ID!) {
      node(id: $id) { ... on ProjectV2IterationField { configuration { completedIterations { id } } } }
    }`, { id: fieldId });
    assert.equal(completed.node.configuration.completedIterations.length, 1);
    for (const iteration of before.iterations) {
      const { data: issue } = await github.rest.issues.create({
        owner, repo, title: `ITEST-${suffix}-${iteration.title}`,
        body: 'Temporary fixture for the next iteration integration test.',
      });
      issues.push(issue.number);
      const itemId = await projects.addIssueToProject(sandbox.projectId, issue.node_id);
      itemIds.push(itemId);
      await projects.setIteration(sandbox.projectId, itemId, fieldId, iteration.id);
    }
    const bindings = (await projects.listProjectItems(sandbox.projectId, fieldId))
      .filter(item => itemIds.includes(item.id));
    assert.equal(bindings.length, 2);
    const input = { projectOwner: owner, projectNumber: number, iterationFieldName: fieldName,
      reminderTitle, currentDateOverride: today };
    await ensureNextIterationReminder(input, projects, core);
    const after = await projects.getIterationMetadata(owner, number, fieldName);
    assert.equal(after.iterations.length, 3);
    assert.equal(after.iterationDuration, before.iterationDuration);
    assert.equal(after.iterationStartDay, before.iterationStartDay);
    for (const iteration of before.iterations) {
      assert.deepEqual(after.iterations.find(candidate => candidate.id === iteration.id), iteration);
    }
    const next = after.iterations.at(-1);
    assert(next, 'Next iteration must exist');
    const nextStart = new Date(`${today}T00:00:00Z`);
    nextStart.setUTCDate(nextStart.getUTCDate() + 7);
    assert.deepEqual({ ...next, id: undefined }, {
      id: undefined, title: 'Sprint 43', startDate: nextStart.toISOString().slice(0, 10), duration: 7,
    });
    const itemsAfter = await projects.listProjectItems(sandbox.projectId, fieldId);
    const reminders = itemsAfter.filter(item => item.title === reminderTitle && item.contentType === 'DraftIssue');
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0]?.iterationId, next.id);
    assert.deepEqual(itemsAfter.filter(item => itemIds.includes(item.id)), bindings);
    await ensureNextIterationReminder(input, projects, core);
    assert.deepEqual(await projects.getIterationMetadata(owner, number, fieldName), after);
    const repeatedItems = await projects.listProjectItems(sandbox.projectId, fieldId);
    assert.deepEqual(repeatedItems.filter(item => itemIds.includes(item.id)), bindings);
    assert.deepEqual(repeatedItems.filter(item => item.title === reminderTitle), reminders);
    core.info(`Created ${next.id}; repeat kept all iteration IDs, both issue bindings and one reminder.`);
  } catch (error) {
    core.error(error instanceof Error ? error : String(error));
    throw error;
  } finally {
    // Also find the field if its creation response was lost; never touch the permanent sandbox field.
    const fields = await github.graphql<{ node: { fields: { nodes: ({ id: string; name: string } | null)[] } } }>(`query($id: ID!) {
      node(id: $id) { ... on ProjectV2 { fields(first: 100) {
        nodes { ... on ProjectV2FieldCommon { id name } }
      } } }
    }`, { id: sandbox.projectId });
    fieldId ??= fields.node.fields.nodes.find(field => field?.name === fieldName)?.id;
    const items = await projects.listProjectItems(sandbox.projectId, fieldId ?? '');
    const cleanup = await Promise.allSettled([
      ...items.filter(item => itemIds.includes(item.id) || item.title === reminderTitle)
        .map(item => projects.deleteProjectItem(sandbox.projectId, item.id)),
      ...issues.map(issue_number => github.rest.issues.update({ owner, repo, issue_number, state: 'closed' })),
    ]);
    if (fieldId) {
      await github.graphql(`mutation($id: ID!) { deleteProjectV2Field(input: { fieldId: $id }) { clientMutationId } }`,
        { id: fieldId });
    }
    const failed = cleanup.filter(result => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Fixture cleanup failed');
  }
}
