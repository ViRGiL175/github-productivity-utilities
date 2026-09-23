import type { IssueManagedCommentGateway, IssueReader, RepositoryCoordinates } from '../../github/IssueRepository.ts';
import type { ProjectIterationGateway, ProjectV2Gateway } from '../../github/ProjectV2Repository.ts';
import type { PullRequestClosingIssuesGateway, PullRequestListGateway, PullRequestMutationGateway } from '../../github/PullRequestRepository.ts';
import type { Logger } from '../../runtime/Logger.ts';
import { parseRepositories } from '../safe-dependabot-pr-link/SafeDependabotPrLink.ts';
import { reconcilePrSprint } from './LinkPrToProject.ts';

export interface ReconcileOpenPrSprintsInput {
  projectOwner: string;
  projectNumber: number;
  backlogRepository: RepositoryCoordinates;
  iterationFieldName: string;
  repositories: string;
}

export async function reconcileOpenPrSprints(
  input: ReconcileOpenPrSprintsInput,
  issues: IssueReader & IssueManagedCommentGateway,
  pullRequests: PullRequestListGateway & PullRequestClosingIssuesGateway & Pick<PullRequestMutationGateway, 'getPullRequestBody'>,
  projects: ProjectV2Gateway & Pick<ProjectIterationGateway, 'getIterationMetadata'>,
  logger: Logger,
  now: () => Date = () => new Date(),
): Promise<void> {
  const repositories = parseRepositories(input.repositories, '', input.projectOwner, logger);
  const failures: string[] = [];
  let checked = 0;

  for (const repository of repositories) {
    for (let page = 1; ; page += 1) {
      const openPullRequests = await pullRequests.listPullRequests(repository, 'open', page, 100);
      for (const pullRequest of openPullRequests) {
        checked += 1;
        try {
          await reconcilePrSprint({
            projectOwner: input.projectOwner,
            projectNumber: input.projectNumber,
            backlogRepository: input.backlogRepository,
            iterationFieldName: input.iterationFieldName,
            statusFieldName: '',
            statusDoneValue: '',
            statusInProgressValue: '',
            statusInReviewValue: '',
            pullRequestNodeId: pullRequest.nodeId,
            pullRequestNumber: pullRequest.number,
            pullRequestRepository: repository,
            pullRequestBodyHint: pullRequest.body ?? '',
            headRef: pullRequest.headRef ?? '',
            action: 'reconcile_sprint',
            requestedReviewersJson: '[]',
          }, issues, pullRequests, projects, logger, now);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${repository.nameWithOwner}#${pullRequest.number}: ${message}`);
          logger.warning(`Could not reconcile Sprint for ${repository.nameWithOwner}#${pullRequest.number}: ${message}`);
        }
      }
      if (openPullRequests.length < 100) break;
    }
  }

  logger.info(`Checked ${checked} open PR(s) in ${repositories.length} repository/repositories for Sprint changes.`);
  if (failures.length > 0) throw new Error(`${failures.length} PR Sprint reconciliation error(s): ${failures.join('; ')}`);
}
