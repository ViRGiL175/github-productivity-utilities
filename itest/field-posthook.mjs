import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { FieldController, FieldUpdateError } from '../src/github/FieldController.ts';
import { createFieldPosthook } from '../src/automations/field-posthook/FieldPosthook.ts';
import { linkPrToProject } from '../src/automations/link-pr-to-project/LinkPrToProject.ts';
import { safeDependabotPrLink } from '../src/automations/safe-dependabot-pr-link/SafeDependabotPrLink.ts';
import { ProjectV2Repository } from '../src/github/ProjectV2Repository.ts';
import { IssueRepository } from '../src/github/IssueRepository.ts';
import { PullRequestRepository } from '../src/github/PullRequestRepository.ts';

export async function run({ github, context, core }) {
  const owner = 'ViRGiL-GH-Productivity';
  const projectId = 'PVT_kwDOD_pocM4BRshl';
  const suffix = `${context.runId}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const projects = new ProjectV2Repository(github);
  const issues = new IssueRepository(github);
  const pulls = new PullRequestRepository(github);
  const controller = new FieldController(github);
  const logger = { info: message => core.info(message), warning: message => core.warning(message) };
  const result = { entities: [], checks: [], cleanup: [] };
  const save = () => writeFile('field-posthook-result.json', JSON.stringify(result, null, 2));
  const check = async (name, fn) => { await fn(); result.checks.push(name); core.info(`PASS ${name}`); await save(); };
  let failure;
  try {
    const issue = (await github.rest.issues.create({ owner, repo: 'scrum-test-backlog', title: `ITEST field posthook ${suffix}`, body: 'Isolated field controller integration fixture.' })).data;
    result.entities.push({ repo: 'scrum-test-backlog', number: issue.number, url: issue.html_url });
    await save();
    const itemId = await projects.addIssueToProject(projectId, issue.node_id);
    const target = { repository: { owner, repo: 'scrum-test-backlog' }, issueNumber: issue.number, project: { owner, number: 1, itemId } };
    const metadata = await github.request('GET /orgs/{org}/issue-fields', { org: owner, headers: { 'X-GitHub-Api-Version': '2026-03-10' } });
    const nativeOptions = metadata.data.find(field => field?.name === 'Horizon')?.options;
    assert(nativeOptions?.length >= 2, 'Sandbox native Horizon needs two existing options');
    const first = nativeOptions[0].name;
    const second = nativeOptions[1].name;
    await check('Both real APIs write only requested fields', async () => {
      const report = await controller.apply({ project: { Priority: 'P0' }, issue: { Horizon: first } }, target);
      assert.deepEqual(report.applied, ['project.Priority', 'issue.Horizon']);
    });
    await check('Equal values and force=false skip writes; force=true overwrites', async () => {
      assert.equal((await controller.apply({ project: { Priority: 'P1' }, issue: { Horizon: second } }, target)).applied.length, 0);
      assert.equal((await controller.apply({ project: { Priority: 'P1' }, issue: { Horizon: second }, force: true }, target)).applied.length, 2);
      assert.equal((await controller.apply({ project: { Priority: 'P1' }, issue: { Horizon: second }, force: true }, target)).applied.length, 0);
      const native = await github.request('GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', { owner, repo: 'scrum-test-backlog', issue_number: issue.number });
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
    async function makePr(label) {
      const branch = `gff-field-posthook-${suffix}-${label}`;
      await github.rest.git.createRef({ owner, repo: 'test-client', ref: `refs/heads/${branch}`, sha: base.data.object.sha });
      await github.rest.repos.createOrUpdateFileContents({ owner, repo: 'test-client', branch, path: `itest/field-posthook-${suffix}.txt`, message: 'Add isolated field posthook fixture', content: Buffer.from(label).toString('base64') });
      const pr = (await github.rest.pulls.create({ owner, repo: 'test-client', head: branch, base: 'main', title: `ITEST field posthook ${suffix} ${label}`, draft: true,
        body: '## Why\nVerify field posthooks on real App-added PRs.\n\n## Changes\nIsolated fixture.\n\n## Validation\nInspect configured fields after addition; do not merge.' })).data;
      result.entities.push({ repo: 'test-client', number: pr.number, url: pr.html_url, branch });
      await save();
      return pr;
    }
    const config = 'project:\n  Horizon diagnostic 2026-10-28: Inbox\n  Priority: P0\nforce: false';
    const posthook = await createFieldPosthook(github, config, owner, 1);
    const normal = await makePr('ordinary');
    const input = pr => ({ projectOwner: owner, projectNumber: 1, backlogRepository: { owner, repo: 'scrum-test-backlog' }, iterationFieldName: 'Iteration', statusFieldName: 'Status',
      statusDoneValue: 'Done', statusInProgressValue: '', statusInReviewValue: '', pullRequestNodeId: pr.node_id, pullRequestNumber: pr.number,
      pullRequestRepository: { owner, repo: 'test-client' }, pullRequestBodyHint: '', headRef: '', action: 'opened', requestedReviewersJson: '[]' });
    await check('Ordinary PR add invokes YAML posthook; replay preserves value', async () => {
      await linkPrToProject({ ...input(normal), fieldPosthook: posthook }, issues, pulls, projects, logger);
      const normalItem = await projects.getContentProjectItem(normal.node_id, projectId, 'Priority');
      await controller.apply({ project: { Priority: 'P1' }, force: true }, { repository: { owner, repo: 'test-client' }, issueNumber: normal.number, project: { owner, number: 1, itemId: normalItem.id } });
      await linkPrToProject({ ...input(normal), fieldPosthook: posthook }, issues, pulls, projects, logger);
      assert.equal((await projects.getContentProjectItem(normal.node_id, projectId, 'Horizon diagnostic 2026-10-28'))?.statusName, 'Inbox');
      assert.equal((await projects.getContentProjectItem(normal.node_id, projectId, 'Priority'))?.statusName, 'P1');
    });
    const unconfigured = await makePr('unconfigured');
    await check('No config retains old behavior', async () => {
      assert.equal(await createFieldPosthook(github, '', owner, 1), undefined);
      await linkPrToProject(input(unconfigured), issues, pulls, projects, logger);
      assert.equal((await projects.getContentProjectItem(unconfigured.node_id, projectId, 'Horizon diagnostic 2026-10-28'))?.statusName, null);
    });
    const bot = await makePr('safe-import');
    await check('Safe Dependabot importer path invokes the same posthook', async () => {
      // Existing integration convention: the App's fixture PR stands in for the configured bot.
      // Restrict to the newest open PR; the future cutoff excludes all closed fixtures.
      const safeInput = { projectOwner: owner, projectNumber: 1, repositories: `${owner}/test-client`, repositoriesJson: '', defaultRepositoryOwner: owner,
        statusFieldName: 'Status', statusStartValue: 'To do', statusFinalValue: 'Done', dependabotLogin: bot.user.login, maxPullRequestsPerRepo: 1,
        closedLookbackDays: 0, fieldPosthook: posthook };
      await safeDependabotPrLink(safeInput, pulls, projects, logger, () => new Date('2100-01-01'));
      await safeDependabotPrLink(safeInput, pulls, projects, logger, () => new Date('2100-01-01'));
      assert.equal((await projects.getContentProjectItem(bot.node_id, projectId, 'Horizon diagnostic 2026-10-28'))?.statusName, 'Inbox');
    });
  } catch (error) {
    failure = error;
    result.error = error.message;
  } finally {
    for (const entity of result.entities) {
      try {
        await github.rest.issues.update({ owner, repo: entity.repo, issue_number: entity.number, state: 'closed' });
        result.cleanup.push({ url: entity.url, state: 'closed' });
      } catch (error) { result.cleanup.push({ url: entity.url, error: error.message }); failure ??= error; }
    }
    result.passed = !failure;
    await save();
    await core.summary.addHeading('Real App field posthook checks').addList(result.checks)
      .addRaw(`\n${result.entities.map(entity => entity.url).join('\n\n')}\n\nFixtures closed, items and branches retained. Result: ${result.passed ? 'PASS' : 'FAIL'}`).write();
  }
  if (failure) throw failure;
}
