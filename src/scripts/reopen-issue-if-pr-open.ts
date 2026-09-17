import type { Octokit } from '@octokit/rest';
import { reopenIssueIfPrOpen } from '../automations/reopen-issue-if-pr-open/ReopenIssueIfPrOpen.ts';
import { IssueRepository } from '../github/IssueRepository.ts';
import { logger, required } from './environment.ts';

export async function run(github: Octokit): Promise<void> {
  await reopenIssueIfPrOpen({
    repository: { owner: required('PROJECT_OWNER'), repo: required('BACKLOG_REPO') },
    issueNumber: Number(process.env.ISSUE_NUMBER || ''),
  }, new IssueRepository(github), logger);
}
