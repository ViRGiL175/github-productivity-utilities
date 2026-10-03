import type { Octokit } from '@octokit/rest';
import { reconcileSubIssueSprints, syncSubIssueSprint } from '../automations/sync-sub-issue-sprint/SyncSubIssueSprint.ts';
import { IssueRepository } from '../github/IssueRepository.ts';
import { ProjectV2Repository } from '../github/ProjectV2Repository.ts';
import { logger, repositoryName, required } from './environment.ts';

export async function run(github: Octokit): Promise<void> {
  if (process.env.ACTION === 'reconcile') {
    const rawIssueNumber = process.env.ISSUE_NUMBER?.trim();
    const parentIssueNumber = rawIssueNumber ? Number(rawIssueNumber) : undefined;
    if (parentIssueNumber !== undefined && (!Number.isSafeInteger(parentIssueNumber) || parentIssueNumber <= 0)) {
      throw new Error('ISSUE_NUMBER must be a positive integer when supplied.');
    }
    await reconcileSubIssueSprints({
      projectOwner: required('PROJECT_OWNER'),
      projectNumber: Number(required('PROJECT_NUMBER')),
      iterationFieldName: required('ITERATION_FIELD_NAME'),
      dryRun: process.env.DRY_RUN === 'true',
      ...(parentIssueNumber === undefined ? {} : {
        parentIssueNumber,
        parentRepository: { owner: required('REPO_OWNER'), repo: repositoryName('REPO_NAME') },
      }),
    }, new IssueRepository(github), new ProjectV2Repository(github), logger);
    return;
  }
  await syncSubIssueSprint({
    action: process.env.ACTION || 'opened',
    projectOwner: required('PROJECT_OWNER'),
    projectNumber: Number(required('PROJECT_NUMBER')),
    iterationFieldName: required('ITERATION_FIELD_NAME'),
    issueNumber: Number(process.env.ISSUE_NUMBER || ''),
    repository: { owner: required('REPO_OWNER'), repo: repositoryName('REPO_NAME') },
  }, new IssueRepository(github), new ProjectV2Repository(github), logger);
}
