import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { Octokit } from '@octokit/rest';
import type { Endpoints } from '@octokit/types';
import type { IntegrationCore } from './runtime.ts';
import type { Logger } from '../src/runtime/Logger.ts';
import { FieldController, FieldUpdateError } from '../src/github/FieldController.ts';
import { createFieldUpdates } from '../src/automations/field-updates/FieldUpdates.ts';
import { linkPrToProject } from '../src/automations/link-pr-to-project/LinkPrToProject.ts';
import { safeDependabotPrLink } from '../src/automations/safe-dependabot-pr-link/SafeDependabotPrLink.ts';
import { ProjectV2Repository } from '../src/github/ProjectV2Repository.ts';
import { IssueRepository } from '../src/github/IssueRepository.ts';
import { PullRequestRepository } from '../src/github/PullRequestRepository.ts';

interface IntegrationResult {

  entities: { repo: string; number: number; url: string; branch?: string }[];
  checks: string[];
  cleanup: { url: string; state?: string; error?: string }[];
  error?: string;
  passed?: boolean;
}

export async function run({ github, context, core }: {
  github: Octokit; context: { runId: number }; core: IntegrationCore;
}): Promise<void> {
  const owner = 'ViRGiL-GH-Productivity';
  const projectId = 'PVT_kwDOD_pocM4BRshl';
  const suffix = `${context.runId}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const projects = new ProjectV2Repository(github);
  const issues = new IssueRepository(github);
  const pulls = new PullRequestRepository(github);
  const controller = new FieldController(github);
  const logger: Logger = { info: message => core.info(message), warning: message => core.warning(message) };
  const result: IntegrationResult = { entities: [], checks: [], cleanup: [] };
  const save = () => writeFile('field-updates-result.json', JSON.stringify(result, null, 2));
  const check = async (name: string, fn: () => Promise<void>) => { await fn(); result.checks.push(name); core.info(`PASS ${name}`); await save(); };
  let failure;
  try {
    const issue = (await github.rest.issues.create({ owner, repo: 'scrum-test-backlog', title: `ITEST field updates ${suffix}`, body: 'Isolated field controller integration fixture.' })).data;
    result.entities.push({ repo: 'scrum-test-backlog', number: issue.number, url: issue.html_url });
    await save();
    const itemId = await projects.addIssueToProject(projectId, issue.node_id);
    const target = { repository: { owner, repo: 'scrum-test-backlog' }, issueNumber: issue.number, project: { owner, number: 1, itemId } };
    const metadata: Endpoints['GET /orgs/{org}/issue-fields']['response'] = await github.request('GET /orgs/{org}/issue-fields', { org: owner, headers: { 'X-GitHub-Api-Version': '2026-03-10' } });
    const nativeOptions = metadata.data.find(field => field?.name === 'Horizon')?.options;
    const first = nativeOptions?.[0]?.name;
    const second = nativeOptions?.[1]?.name;
    assert(first && second, 'Sandbox native Horizon needs two existing options');
    await check('Both real APIs write only requested fields', async () => {
      const report = await controller.apply({ project: { Priority: 'P0' }, issue: { Horizon: first } }, target);
      assert.deepEqual(report.applied, ['project.Priority', 'issue.Horizon']);
    });
    await check('Equal values and force=false skip writes; force=true overwrites', async () => {
      assert.equal((await controller.apply({ project: { Priority: 'P1' }, issue: { Horizon: second } }, target)).applied.length, 0);
      assert.equal((await controller.apply({ project: { Priority: 'P1' }, issue: { Horizon: second }, force: true }, target)).applied.length, 2);
      assert.equal((await controller.apply({ project: { Priority: 'P1' }, issue: { Horizon: second }, force: true }, target)).applied.length, 0);
      const native: Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values']['response'] = await github.request('GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', { owner, repo: 'scrum-test-backlog', issue_number: issue.number });
      assert.equal(native.data.find(value => value.issue_field_name === 'Horizon')?.single_select_option?.name, second);
      assert.equal((await projects.getContentProjectItem(issue.node_id, projectId, 'Priority'))?.statusName, 'P1');
    });
    await check('Unknown fields/options fail before writes, including force', async () => {
      await assert.rejects(controller.apply({ project: { Priority: 'P0' }, issue: { [`missing-${suffix}`]: first }, force: true }, target), /issue: unknown/);
      await assert.rejects(controller.apply({ project: { Priority: `missing-${suffix}` }, force: true }, target), /project.Priority option: unknown/);
      assert.equal((await projects.getContentProjectItem(issue.node_id, projectId, 'Priority'))?.statusName, 'P1');
    });
    await check('Partial API failure reports applied and uncertain scopes', async () => {
      await assert.rejects(controller.apply({ project: { Priority: 'P0' }, issue: { 'Start date': 'not-a-date' }, force: true }, target), error => {
        assert(error instanceof FieldUpdateError);
        assert.deepEqual(error.report.applied, ['project.Priority']);
        assert.deepEqual(error.uncertain, ['issue.Start date']);
        return true;
      });
      assert.equal((await projects.getContentProjectItem(issue.node_id, projectId, 'Priority'))?.statusName, 'P0');
    });

    const base = await github.rest.git.getRef({ owner, repo: 'test-client', ref: 'heads/main' });
    async function makePr(label: string) {
      const branch = `gff-field-updates-${suffix}-${label}`;
      await github.rest.git.createRef({ owner, repo: 'test-client', ref: `refs/heads/${branch}`, sha: base.data.object.sha });
      await github.rest.repos.createOrUpdateFileContents({ owner, repo: 'test-client', branch, path: `itest/field-updates-${suffix}.txt`, message: 'Add isolated field updates fixture', content: Buffer.from(label).toString('base64') });
      const pr = (await github.rest.pulls.create({ owner, repo: 'test-client', head: branch, base: 'main', title: `ITEST field updates ${suffix} ${label}`, draft: true,
        body: '## Why\nVerify field updatess on real App-added PRs.\n\n## Changes\nIsolated fixture.\n\n## Validation\nInspect configured fields after addition; do not merge.' })).data;
      result.entities.push({ repo: 'test-client', number: pr.number, url: pr.html_url, branch });
      await save();
      return pr;
    }
    const config = 'project:\n  Horizon diagnostic 2026-10-28: Inbox\n  Priority: P0\nforce: false';
    const updates = await createFieldUpdates(github, config, owner, 1);
    const normal = await makePr('ordinary');
    const input = (pr: { node_id: string; number: number }) => ({ projectOwner: owner, projectNumber: 1, backlogRepository: { owner, repo: 'scrum-test-backlog' }, iterationFieldName: 'Iteration', statusFieldName: 'Status',
      statusDoneValue: 'Done', statusInProgressValue: '', statusInReviewValue: '', pullRequestNodeId: pr.node_id, pullRequestNumber: pr.number,
      pullRequestRepository: { owner, repo: 'test-client' }, pullRequestBodyHint: '', headRef: '', action: 'opened', requestedReviewersJson: '[]' });
    await check('Ordinary PR add invokes YAML posthook; replay preserves value', async () => {
      await linkPrToProject({ ...input(normal), fieldUpdates: updates }, issues, pulls, projects, logger);
      const normalItem = await projects.getContentProjectItem(normal.node_id, projectId, 'Priority');
      assert(normalItem, 'Ordinary PR must be in the project');
      await controller.apply({ project: { Priority: 'P1' }, force: true }, { repository: { owner, repo: 'test-client' }, issueNumber: normal.number, project: { owner, number: 1, itemId: normalItem.id } });
      await linkPrToProject({ ...input(normal), fieldUpdates: updates }, issues, pulls, projects, logger);
      assert.equal((await projects.getContentProjectItem(normal.node_id, projectId, 'Horizon diagnostic 2026-10-28'))?.statusName, 'Inbox');
      assert.equal((await projects.getContentProjectItem(normal.node_id, projectId, 'Priority'))?.statusName, 'P1');
    });
    const unconfigured = await makePr('unconfigured');
    await check('No config retains old behavior', async () => {
      assert.equal(await createFieldUpdates(github, '', owner, 1), undefined);
      await linkPrToProject(input(unconfigured), issues, pulls, projects, logger);
      assert.equal((await projects.getContentProjectItem(unconfigured.node_id, projectId, 'Horizon diagnostic 2026-10-28'))?.statusName, null);
    });
    const bot = await makePr('safe-import');
    await check('Safe Dependabot importer path invokes the same posthook', async () => {
      // Existing integration convention: the App's fixture PR stands in for the configured bot.
      // Restrict to the newest open PR; the future cutoff excludes all closed fixtures.
      const safeInput = { projectOwner: owner, projectNumber: 1, repositories: `${owner}/test-client`, repositoriesJson: '', defaultRepositoryOwner: owner,
        statusFieldName: 'Status', statusStartValue: 'To do', statusFinalValue: 'Done', dependabotLogin: bot.user.login, maxPullRequestsPerRepo: 1,
        closedLookbackDays: 0, fieldUpdates: updates };
      await safeDependabotPrLink(safeInput, pulls, projects, logger, () => new Date('2100-01-01'));
      await safeDependabotPrLink(safeInput, pulls, projects, logger, () => new Date('2100-01-01'));
      assert.equal((await projects.getContentProjectItem(bot.node_id, projectId, 'Horizon diagnostic 2026-10-28'))?.statusName, 'Inbox');
    });
  } catch (error) {
    failure = error;
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const entity of result.entities) {
      try {
        await github.rest.issues.update({ owner, repo: entity.repo, issue_number: entity.number, state: 'closed' });
        result.cleanup.push({ url: entity.url, state: 'closed' });
      } catch (error) { result.cleanup.push({ url: entity.url, error: error instanceof Error ? error.message : String(error) }); failure ??= error; }
    }
    result.passed = !failure;
    await save();
    await core.summary.addHeading('Real App field updates checks').addList(result.checks)
      .addRaw(`\n${result.entities.map(entity => entity.url).join('\n\n')}\n\nFixtures closed, items and branches retained. Result: ${result.passed ? 'PASS' : 'FAIL'}`).write();
  }
  if (failure) throw failure;
}
