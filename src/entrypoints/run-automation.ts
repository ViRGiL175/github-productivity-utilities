import { Octokit } from '@octokit/rest';
import { CollectLinkedContext } from '../automations/collect-linked-context/CollectLinkedContext.js';
import { EnsureNextIterationReminder } from '../automations/ensure-next-iteration-reminder/EnsureNextIterationReminder.js';
import { LinkPrToProject } from '../automations/link-pr-to-project/LinkPrToProject.js';
import {
  GeminiApiClient,
  GeminiGenerateText,
  LocalContextFileReader,
} from '../automations/gemini-generate-text/GeminiGenerateText.js';
import { ReopenIssueIfPrOpen } from '../automations/reopen-issue-if-pr-open/ReopenIssueIfPrOpen.js';
import { SafeDependabotPrLink } from '../automations/safe-dependabot-pr-link/SafeDependabotPrLink.js';
import { SyncSubIssueSprint } from '../automations/sync-sub-issue-sprint/SyncSubIssueSprint.js';
import { IssueRepository } from '../github/IssueRepository.js';
import { LinkedContextRepository } from '../github/LinkedContextRepository.js';
import { ProjectV2Repository } from '../github/ProjectV2Repository.js';
import { PullRequestRepository } from '../github/PullRequestRepository.js';
import { AutomationRunner } from '../runtime/AutomationRunner.js';
import { ConsoleLogger } from '../runtime/Logger.js';
import { writeGitHubOutput } from '../runtime/GitHubOutput.js';

async function main(): Promise<void> {
  const automationName = process.argv[2] ?? '';
  const token = requireEnvironmentVariable('AUTOMATION_TOKEN');
  const octokit = new Octokit({ auth: token });
  const logger = new ConsoleLogger();
  const issues = new IssueRepository(octokit);
  const linkedContext = new LinkedContextRepository(octokit);
  const projects = new ProjectV2Repository(octokit);
  const pullRequests = new PullRequestRepository(octokit);

  const runner = new AutomationRunner(
    new Map([
      [
        'link-pr-to-project',
        {
          run: async () => {
            const automation = new LinkPrToProject(issues, pullRequests, projects, logger);
            await automation.run({
              projectOwner: requireEnvironmentVariable('PROJECT_OWNER'),
              projectNumber: Number(requireEnvironmentVariable('PROJECT_NUMBER')),
              backlogRepository: {
                owner: requireEnvironmentVariable('BACKLOG_REPO_OWNER'),
                repo: requireEnvironmentVariable('BACKLOG_REPO'),
              },
              iterationFieldName: requireEnvironmentVariable('ITERATION_FIELD_NAME'),
              statusFieldName: requireEnvironmentVariable('STATUS_FIELD_NAME'),
              statusDoneValue: requireEnvironmentVariable('STATUS_DONE_VALUE'),
              statusInProgressValue: process.env.STATUS_IN_PROGRESS_VALUE ?? '',
              statusInReviewValue: process.env.STATUS_IN_REVIEW_VALUE ?? '',
              pullRequestNodeId: requireEnvironmentVariable('PULL_REQUEST_NODE_ID'),
              pullRequestNumber: Number(requireEnvironmentVariable('PULL_REQUEST_NUMBER')),
              pullRequestRepository: {
                owner: requireEnvironmentVariable('PULL_REQUEST_REPO_OWNER'),
                repo: requireEnvironmentVariable('PULL_REQUEST_REPO_NAME'),
              },
              pullRequestBodyHint: process.env.PULL_REQUEST_BODY ?? '',
              headRef: process.env.HEAD_REF ?? '',
              action: process.env.ACTION || 'opened',
              requestedReviewersJson: process.env.REQUESTED_REVIEWERS_JSON || '[]',
            });
          },
        },
      ],
      [
        'ensure-next-iteration-reminder',
        {
          run: async () => {
            const automation = new EnsureNextIterationReminder(projects, logger);
            await automation.run({
              projectOwner: requireEnvironmentVariable('PROJECT_OWNER'),
              projectNumber: Number(requireEnvironmentVariable('PROJECT_NUMBER')),
              iterationFieldName: requireEnvironmentVariable('ITERATION_FIELD_NAME'),
              reminderTitle: requireEnvironmentVariable('REMINDER_TITLE'),
              currentDateOverride: process.env.CURRENT_DATE_OVERRIDE ?? '',
            });
          },
        },
      ],
      [
        'safe-dependabot-pr-link',
        {
          run: async () => {
            const automation = new SafeDependabotPrLink(pullRequests, projects, logger);
            await automation.run({
              projectOwner: requireEnvironmentVariable('PROJECT_OWNER'),
              projectNumber: Number(requireEnvironmentVariable('PROJECT_NUMBER')),
              repositories: process.env.REPOSITORIES ?? '',
              repositoriesJson: process.env.REPOSITORIES_JSON ?? '',
              defaultRepositoryOwner: requireEnvironmentVariable('REPOSITORY_OWNER'),
              statusFieldName: requireEnvironmentVariable('STATUS_FIELD_NAME'),
              statusStartValue: requireEnvironmentVariable('STATUS_START_VALUE'),
              statusFinalValue: requireEnvironmentVariable('STATUS_FINAL_VALUE'),
              dependabotLogin: process.env.DEPENDABOT_LOGIN || 'dependabot[bot]',
              maxPullRequestsPerRepo: Number(process.env.MAX_PULL_REQUESTS_PER_REPO || '50'),
              closedLookbackDays: Number(process.env.CLOSED_LOOKBACK_DAYS || '30'),
            });
          },
        },
      ],
      [
        'sync-sub-issue-sprint',
        {
          run: async () => {
            const automation = new SyncSubIssueSprint(issues, projects, logger);
            await automation.run({
              action: process.env.ACTION || 'opened',
              projectOwner: requireEnvironmentVariable('PROJECT_OWNER'),
              projectNumber: Number(requireEnvironmentVariable('PROJECT_NUMBER')),
              iterationFieldName: requireEnvironmentVariable('ITERATION_FIELD_NAME'),
              issueNumber: Number(process.env.ISSUE_NUMBER || ''),
              repository: {
                owner: requireEnvironmentVariable('REPO_OWNER'),
                repo: requireEnvironmentVariable('REPO_NAME'),
              },
            });
          },
        },
      ],
      [
        'collect-linked-context',
        {
          run: async () => {
            const automation = new CollectLinkedContext(linkedContext, logger);
            const value = await automation.run({
              text: process.env.INPUT_TEXT ?? '',
              defaultRepository: parseRepository(requireEnvironmentVariable('CALLER_REPOSITORY')),
            });
            await writeGitHubOutput('value', value);
          },
        },
      ],
      [
        'gemini-generate-text',
        {
          run: async () => {
            const automation = new GeminiGenerateText(
              new GeminiApiClient(requireEnvironmentVariable('GEMINI_API_KEY')),
              new LocalContextFileReader(),
              logger,
            );
            const text = await automation.run({
              promptText: requireEnvironmentVariable('PROMPT_TEXT'),
              inputText: process.env.INPUT_TEXT ?? '',
              contextFiles: process.env.CONTEXT_FILES ?? '',
              model: requireEnvironmentVariable('MODEL'),
            });
            await writeGitHubOutput('text', text);
          },
        },
      ],
      [
        'reopen-issue-if-pr-open',
        {
          run: async () => {
            const automation = new ReopenIssueIfPrOpen(issues, logger);
            await automation.run({
              repository: {
                owner: requireEnvironmentVariable('PROJECT_OWNER'),
                repo: requireEnvironmentVariable('BACKLOG_REPO'),
              },
              issueNumber: Number(process.env.ISSUE_NUMBER || ''),
            });
          },
        },
      ],
    ]),
  );

  await runner.run(automationName);
}

function parseRepository(value: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = value.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Expected owner/repository, received: ${value}`);
  }
  return { owner, repo };
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is empty.`);
  }

  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
