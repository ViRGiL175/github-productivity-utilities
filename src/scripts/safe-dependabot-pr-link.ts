import type { Octokit } from '@octokit/rest';
import { safeDependabotPrLink } from '../automations/safe-dependabot-pr-link/SafeDependabotPrLink.ts';
import { ProjectV2Repository } from '../github/ProjectV2Repository.ts';
import { PullRequestRepository } from '../github/PullRequestRepository.ts';
import { logger, required } from './environment.ts';

export async function run(github: Octokit): Promise<void> {
  await safeDependabotPrLink({
    projectOwner: required('PROJECT_OWNER'),
    projectNumber: Number(required('PROJECT_NUMBER')),
    repositories: process.env.REPOSITORIES ?? '',
    repositoriesJson: process.env.REPOSITORIES_JSON ?? '',
    defaultRepositoryOwner: required('REPOSITORY_OWNER'),
    statusFieldName: required('STATUS_FIELD_NAME'),
    statusStartValue: required('STATUS_START_VALUE'),
    statusFinalValue: required('STATUS_FINAL_VALUE'),
    dependabotLogin: process.env.DEPENDABOT_LOGIN || 'dependabot[bot]',
    maxPullRequestsPerRepo: Number(process.env.MAX_PULL_REQUESTS_PER_REPO || '50'),
    closedLookbackDays: Number(process.env.CLOSED_LOOKBACK_DAYS || '30'),
  }, new PullRequestRepository(github), new ProjectV2Repository(github), logger);
}
