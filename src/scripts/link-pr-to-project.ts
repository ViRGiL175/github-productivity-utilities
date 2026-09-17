import type { Octokit } from '@octokit/rest';
import { linkPrToProject } from '../automations/link-pr-to-project/LinkPrToProject.ts';
import { IssueRepository } from '../github/IssueRepository.ts';
import { ProjectV2Repository } from '../github/ProjectV2Repository.ts';
import { PullRequestRepository } from '../github/PullRequestRepository.ts';
import { logger, repositoryName, required } from './environment.ts';

export async function run(github: Octokit): Promise<void> {
  await linkPrToProject({
    projectOwner: required('PROJECT_OWNER'),
    projectNumber: Number(required('PROJECT_NUMBER')),
    backlogRepository: { owner: required('BACKLOG_REPO_OWNER'), repo: required('BACKLOG_REPO') },
    iterationFieldName: required('ITERATION_FIELD_NAME'),
    statusFieldName: required('STATUS_FIELD_NAME'),
    statusDoneValue: required('STATUS_DONE_VALUE'),
    statusInProgressValue: process.env.STATUS_IN_PROGRESS_VALUE ?? '',
    statusInReviewValue: process.env.STATUS_IN_REVIEW_VALUE ?? '',
    pullRequestNodeId: required('PULL_REQUEST_NODE_ID'),
    pullRequestNumber: Number(required('PULL_REQUEST_NUMBER')),
    pullRequestRepository: { owner: required('PULL_REQUEST_REPO_OWNER'), repo: repositoryName('PULL_REQUEST_REPO_NAME') },
    pullRequestBodyHint: process.env.PULL_REQUEST_BODY ?? '',
    headRef: process.env.HEAD_REF ?? '',
    action: process.env.ACTION || 'opened',
    reviewState: process.env.REVIEW_STATE ?? '',
    requestedReviewersJson: process.env.REQUESTED_REVIEWERS_JSON || '[]',
  }, new IssueRepository(github), new PullRequestRepository(github), new ProjectV2Repository(github), logger);
}
