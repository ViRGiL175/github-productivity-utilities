import type { IssueReader, RepositoryCoordinates, SubIssueReader } from '../../github/IssueRepository.ts';
import { parseRepositoryUrl } from '../../github/IssueRepository.ts';
import type { ProjectIssueScanGateway, ProjectV2Gateway } from '../../github/ProjectV2Repository.ts';
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

export async function reconcileSubIssueSprints(
  input: Pick<SyncSubIssueSprintInput, 'projectOwner' | 'projectNumber' | 'iterationFieldName'> & {
    dryRun: boolean;
    parentIssueNumber?: number;
    parentRepository?: RepositoryCoordinates;
  },
  issues: SubIssueReader,
  projects: ProjectV2Gateway & ProjectIssueScanGateway,
  logger: Logger,
): Promise<void> {
  const project = await projects.getProjectMetadata(input.projectOwner, input.projectNumber, input.iterationFieldName);
  const items = await projects.listOpenIssuesWithField(project.projectId, input.iterationFieldName);
  const parents = items.filter((item) => item.iterationId && item.subIssueCount > 0 && (
    !input.parentIssueNumber || (item.number === input.parentIssueNumber &&
      (!input.parentRepository || item.repositoryNameWithOwner.toLowerCase() ===
        `${input.parentRepository.owner}/${input.parentRepository.repo}`.toLowerCase()))
  ));
  const failures: string[] = [];
  for (const parent of parents) {
    const parentLabel = `${parent.repositoryNameWithOwner}#${parent.number}`;
    try {
      const parentRepository = parseRepositoryName(parent.repositoryNameWithOwner);
      const children = await issues.listSubIssues(parentRepository, parent.number);
      for (const child of children.filter((candidate) => candidate.isOpen && !candidate.isPullRequest)) {
        const childRepository = parseRepositoryUrl(child.repositoryUrl);
        const childLabel = `${childRepository.owner}/${childRepository.repo}#${child.number}`;
        try {
          const currentParent = await projects.getIssueProjectItem(parent.nodeId, project.projectId, input.iterationFieldName);
          if (currentParent?.iterationId !== parent.iterationId) {
            logger.info(`Sprint of ${parentLabel} changed during the scan; retrying next run.`);
            break;
          }
          const item = await projects.getIssueProjectItem(child.nodeId, project.projectId, input.iterationFieldName);
          if (item?.iterationId === parent.iterationId) continue;
          if (input.dryRun) {
            logger.info(`DRY RUN: would copy Sprint from ${parentLabel} to ${childLabel}${item ? '' : ' and add it to the project'}.`);
            continue;
          }
          const childItemId = item?.id ?? await projects.addIssueToProject(project.projectId, child.nodeId);
          await projects.setIteration(project.projectId, childItemId, project.iterationFieldId, parent.iterationId!);
          logger.info(`Copied Sprint from ${parentLabel} to ${childLabel}.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${childLabel}: ${message}`);
          logger.warning(`Could not sync ${childLabel}: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${parentLabel}: ${message}`);
      logger.warning(`Could not scan ${parentLabel}: ${message}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} sprint sync error(s): ${failures.join('; ')}`);
  logger.info(`Checked ${parents.length} parent issue(s) with Sprint and sub-issues.`);
}

function parseRepositoryName(name: string): RepositoryCoordinates {
  const [owner, repo, extra] = name.split('/');
  if (!owner || !repo || extra) throw new Error(`Invalid repository name: ${name}`);
  return { owner, repo };
}
