import type { Octokit } from '@octokit/rest';
import { reconcileOpenPrSprints } from '../automations/link-pr-to-project/ReconcileOpenPrSprints.ts';
import { IssueRepository } from '../github/IssueRepository.ts';
import { ProjectV2Repository } from '../github/ProjectV2Repository.ts';
import { PullRequestRepository } from '../github/PullRequestRepository.ts';
import { logger, required } from './environment.ts';

export async function run(github: Octokit): Promise<void> {
  await reconcileOpenPrSprints({
    projectOwner: required('PROJECT_OWNER'),
    projectNumber: Number(required('PROJECT_NUMBER')),
    backlogRepository: { owner: required('BACKLOG_REPO_OWNER'), repo: required('BACKLOG_REPO') },
    iterationFieldName: required('ITERATION_FIELD_NAME'),
    repositories: required('REPOSITORIES'),
    pullRequestNumber: Number(process.env.RECONCILE_PULL_REQUEST_NUMBER || '0'),
  }, new IssueRepository(github), new PullRequestRepository(github), new ProjectV2Repository(github), logger);
}
