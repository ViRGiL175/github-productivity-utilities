import type { IssueReader, RepositoryCoordinates } from '../../github/IssueRepository.ts';
import { parseRepositoryUrl } from '../../github/IssueRepository.ts';
import type { ProjectV2Gateway } from '../../github/ProjectV2Repository.ts';
import type { Logger } from '../../runtime/Logger.ts';

export interface SyncSubIssueSprintInput {
  action: string;
  projectOwner: string;
  projectNumber: number;
  iterationFieldName: string;
  issueNumber: number;
  repository: RepositoryCoordinates;
}

export async function syncSubIssueSprint(
input: SyncSubIssueSprintInput,
issues: IssueReader,
projects: ProjectV2Gateway,
logger: Logger,
): Promise<void> {
  if (input.action !== 'opened') {
    logger.info(`Action is "${input.action}", so sprint sync is skipped.`);
    return;
  }

  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('A valid issue_number input or github.event.issue.number is required.');
  }

  const issue = await issues.getIssue(input.repository, input.issueNumber);
  if (issue.isPullRequest) {
    logger.info(`Issue #${issue.number} is a pull request. Nothing to sync.`);
    return;
  }

  const parentIssue = await issues.getParentIssue(input.repository, issue.number);
  if (!parentIssue) {
    logger.info(`Issue #${issue.number} has no parent issue. Nothing to sync.`);
    return;
  }

  const parentRepository = parseRepositoryUrl(parentIssue.repositoryUrl);
  logger.info(`Found parent issue ${parentRepository.owner}/${parentRepository.repo}#${parentIssue.number}.`);

  const project = await projects.getProjectMetadata(
    input.projectOwner,
    input.projectNumber,
    input.iterationFieldName,
  );
  const parentProjectItem = await projects.getIssueProjectItem(
    parentIssue.nodeId,
    project.projectId,
    input.iterationFieldName,
  );

  if (!parentProjectItem) {
    logger.info(
      `Parent issue ${parentRepository.owner}/${parentRepository.repo}#${parentIssue.number} is not in project ${input.projectOwner}#${input.projectNumber}.`,
    );
    return;
  }

  if (!parentProjectItem.iterationId) {
    logger.info(
      `Parent issue ${parentRepository.owner}/${parentRepository.repo}#${parentIssue.number} has no value in field ${input.iterationFieldName}.`,
    );
    return;
  }

  const childProjectItem = await projects.getIssueProjectItem(
    issue.nodeId,
    project.projectId,
    input.iterationFieldName,
  );
  let childProjectItemId = childProjectItem?.id;

  if (!childProjectItemId) {
    logger.info(`Sub-issue #${issue.number} is not in project yet. Adding it now.`);
    childProjectItemId = await projects.addIssueToProject(project.projectId, issue.nodeId);
  }

  const iterationLabel = parentProjectItem.iterationTitle || parentProjectItem.iterationId;
  if (childProjectItem?.iterationId === parentProjectItem.iterationId) {
    logger.info(`Sub-issue #${issue.number} already has sprint ${iterationLabel}.`);
    return;
  }

  await projects.setIteration(
    project.projectId,
    childProjectItemId,
    project.iterationFieldId,
    parentProjectItem.iterationId,
  );
  logger.info(`Copied sprint ${iterationLabel} from parent issue to sub-issue #${issue.number}.`);
}
