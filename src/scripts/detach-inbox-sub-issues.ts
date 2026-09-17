import type { Octokit } from '@octokit/rest';
import { detachInboxSubIssues } from '../automations/detach-inbox-sub-issues/DetachInboxSubIssues.ts';
import { IssueRepository } from '../github/IssueRepository.ts';
import { ProjectV2Repository } from '../github/ProjectV2Repository.ts';
import { logger, required } from './environment.ts';

export async function run(github: Octokit): Promise<void> {
  await detachInboxSubIssues({
    projectOwner: required('PROJECT_OWNER'),
    projectNumber: Number(required('PROJECT_NUMBER')),
    horizonFieldName: process.env.HORIZON_FIELD_NAME || 'Horizon',
    inboxValue: process.env.INBOX_VALUE || '📥 Inbox',
    issueNodeId: required('ISSUE_NODE_ID'),
    issueRepository: { owner: required('ISSUE_REPO_OWNER'), repo: required('ISSUE_REPO_NAME') },
    issueNumber: Number(required('ISSUE_NUMBER')),
    previousHorizon: process.env.PREVIOUS_HORIZON ?? '',
    currentHorizon: required('CURRENT_HORIZON'),
    dryRun: process.env.DRY_RUN === 'true',
  }, new ProjectV2Repository(github), new IssueRepository(github), logger);
}
