import { Octokit } from '@octokit/rest';
import { CollectLinkedContext } from '../automations/collect-linked-context/CollectLinkedContext.js';
import { ReopenIssueIfPrOpen } from '../automations/reopen-issue-if-pr-open/ReopenIssueIfPrOpen.js';
import { SyncSubIssueSprint } from '../automations/sync-sub-issue-sprint/SyncSubIssueSprint.js';
import { IssueRepository } from '../github/IssueRepository.js';
import { LinkedContextRepository } from '../github/LinkedContextRepository.js';
import { ProjectV2Repository } from '../github/ProjectV2Repository.js';
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

  const runner = new AutomationRunner(
    new Map([
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
