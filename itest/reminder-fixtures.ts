import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Octokit } from '@octokit/rest';
import { ProjectV2Repository } from '../src/github/ProjectV2Repository.ts';
import type { IntegrationCore } from './runtime.ts';

type FixtureCore = Pick<IntegrationCore, 'info'> & { setOutput(name: string, value: string): void };

export async function prepareReminder(
  github: Octokit, core: FixtureCore, scenario: 'before-first' | 'empty-current',
): Promise<void> {
  const { PROJECT_OWNER, PROJECT_NUMBER, ITERATION_FIELD_NAME, REMINDER_TITLE } = process.env;
  assert(PROJECT_OWNER && PROJECT_NUMBER && ITERATION_FIELD_NAME && REMINDER_TITLE);
  const projects = new ProjectV2Repository(github);
  const { projectId, iterationFieldId, iterations } = await projects.getIterationMetadata(
    PROJECT_OWNER, Number(PROJECT_NUMBER), ITERATION_FIELD_NAME,
  );
  const items = await projects.listProjectItems(projectId, iterationFieldId);
  for (const item of items.filter(item => item.contentType === 'DraftIssue' && item.title === REMINDER_TITLE)) {
    await projects.deleteProjectItem(projectId, item.id);
  }

  let target = iterations[0];
  let date: string;
  if (scenario === 'empty-current') {
    // The first and last iterations are shared with the other sandbox fixtures.
    target = iterations.slice(1, -1).find(iteration => !items.some(item =>
      item.contentType === 'Issue' && item.iterationId === iteration.id));
    assert(target, 'Need an empty interior iteration in the sandbox.');
    const itemId = await projects.createDraftIssue(projectId, REMINDER_TITLE);
    await projects.setIteration(projectId, itemId, iterationFieldId, target.id);
    for (let attempt = 1; ; attempt++) {
      const visible = (await projects.listProjectItems(projectId, iterationFieldId)).find(item => item.id === itemId);
      if (visible?.title === REMINDER_TITLE && visible.iterationId === target.id) break;
      assert(attempt < 12, 'Pre-existing reminder did not become visible.');
      await delay(2000);
    }
    date = target.startDate;
  } else {
    assert(target && iterations.length >= 2, 'Need at least two sandbox iterations.');
    const beforeFirst = new Date(`${target.startDate}T00:00:00Z`);
    beforeFirst.setUTCDate(beforeFirst.getUTCDate() - 1);
    date = beforeFirst.toISOString().slice(0, 10);
  }
  core.setOutput('project_id', projectId);
  core.setOutput('reminder_title', REMINDER_TITLE);
  core.setOutput('target_iteration_id', target.id);
  core.setOutput('current_date_override', date);
}

interface DraftItem {
  id: string;
  content: { __typename: string; title?: string } | null;
  iteration: { iterationId?: string } | null;
}

interface DraftPage {
  node: { items: { nodes: DraftItem[]; pageInfo: { hasNextPage: boolean; endCursor: string } } };
}

async function readReminders(github: Octokit, projectId: string, title: string): Promise<DraftItem[]> {
  const items: DraftItem[] = [];
  let after: string | null = null;
  // Read the target field directly, independently of the production item mapping.
  for (;;) {
    const data: DraftPage = await github.graphql(`query($project: ID!, $field: String!, $after: String) {
        node(id: $project) { ... on ProjectV2 { items(first: 100, after: $after) {
          nodes { id content { __typename ... on DraftIssue { title } }
            iteration: fieldValueByName(name: $field) { ... on ProjectV2ItemFieldIterationValue { iterationId } }
          }
          pageInfo { hasNextPage endCursor }
        } } }
      }`, { project: projectId, field: process.env.ITERATION_FIELD_NAME, after });
    const page = data.node.items;
    items.push(...page.nodes.filter(item => item.content?.__typename === 'DraftIssue' && item.content.title === title));
    if (!page.pageInfo.hasNextPage) return items;
    after = page.pageInfo.endCursor;
  }
}

export async function assertReminder(github: Octokit, attempts = 1): Promise<void> {
  const { PROJECT_ID, REMINDER_TITLE, TARGET_ITERATION_ID } = process.env;
  assert(PROJECT_ID && REMINDER_TITLE && TARGET_ITERATION_ID);
  for (let attempt = 1; ; attempt++) {
    const drafts = await readReminders(github, PROJECT_ID, REMINDER_TITLE);
    if (drafts.length === 1 && drafts[0]?.iteration?.iterationId === TARGET_ITERATION_ID) return;
    if (attempt === attempts) {
      assert.equal(drafts.length, 1, `Expected one reminder named ${REMINDER_TITLE}`);
      assert.equal(drafts[0]?.iteration?.iterationId, TARGET_ITERATION_ID, 'Reminder is in the wrong iteration');
    }
    await delay(5000);
  }
}

export async function cleanReminders(github: Octokit): Promise<void> {
  const { PROJECT_ID, REMINDER_TITLE } = process.env;
  assert(PROJECT_ID && REMINDER_TITLE);
  const projects = new ProjectV2Repository(github);
  for (const item of await readReminders(github, PROJECT_ID, REMINDER_TITLE)) {
    await projects.deleteProjectItem(PROJECT_ID, item.id);
  }
}
