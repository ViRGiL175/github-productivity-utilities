import type { IssueReader, RepositoryCoordinates } from '../../github/IssueRepository.js';
import { parseRepositoryUrl } from '../../github/IssueRepository.js';
import type { ProjectV2Gateway } from '../../github/ProjectV2Repository.js';
import type { Logger } from '../../runtime/Logger.js';

export interface SyncSubIssueSprintInput {
  action: string;
  projectOwner: string;
  projectNumber: number;
  iterationFieldName: string;
  issueNumber: number;
  repository: RepositoryCoordinates;
}

export class SyncSubIssueSprint {
  constructor(
    private readonly issues: IssueReader,
    private readonly projects: ProjectV2Gateway,
    private readonly logger: Logger,
  ) {}

  async run(input: SyncSubIssueSprintInput): Promise<void> {
    if (input.action !== 'opened') {
      this.logger.info(`Action is "${input.action}", so sprint sync is skipped.`);
      return;
    }

    if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
      throw new Error('A valid issue_number input or github.event.issue.number is required.');
    }

    const issue = await this.issues.getIssue(input.repository, input.issueNumber);
    if (issue.isPullRequest) {
      this.logger.info(`Issue #${issue.number} is a pull request. Nothing to sync.`);
      return;
    }

    const parentIssue = await this.issues.getParentIssue(input.repository, issue.number);
    if (!parentIssue) {
      this.logger.info(`Issue #${issue.number} has no parent issue. Nothing to sync.`);
      return;
    }

    const parentRepository = parseRepositoryUrl(parentIssue.repositoryUrl);
    this.logger.info(`Found parent issue ${parentRepository.owner}/${parentRepository.repo}#${parentIssue.number}.`);

    const project = await this.projects.getProjectMetadata(
      input.projectOwner,
      input.projectNumber,
      input.iterationFieldName,
    );
    const parentProjectItem = await this.projects.getIssueProjectItem(
      parentIssue.nodeId,
      project.projectId,
      input.iterationFieldName,
    );

    if (!parentProjectItem) {
      this.logger.info(
        `Parent issue ${parentRepository.owner}/${parentRepository.repo}#${parentIssue.number} is not in project ${input.projectOwner}#${input.projectNumber}.`,
      );
      return;
    }

    if (!parentProjectItem.iterationId) {
      this.logger.info(
        `Parent issue ${parentRepository.owner}/${parentRepository.repo}#${parentIssue.number} has no value in field ${input.iterationFieldName}.`,
      );
      return;
    }

    const childProjectItem = await this.projects.getIssueProjectItem(
      issue.nodeId,
      project.projectId,
      input.iterationFieldName,
    );
    let childProjectItemId = childProjectItem?.id;

    if (!childProjectItemId) {
      this.logger.info(`Sub-issue #${issue.number} is not in project yet. Adding it now.`);
      childProjectItemId = await this.projects.addIssueToProject(project.projectId, issue.nodeId);
    }

    const iterationLabel = parentProjectItem.iterationTitle || parentProjectItem.iterationId;
    if (childProjectItem?.iterationId === parentProjectItem.iterationId) {
      this.logger.info(`Sub-issue #${issue.number} already has sprint ${iterationLabel}.`);
      return;
    }

    await this.projects.setIteration(
      project.projectId,
      childProjectItemId,
      project.iterationFieldId,
      parentProjectItem.iterationId,
    );
    this.logger.info(`Copied sprint ${iterationLabel} from parent issue to sub-issue #${issue.number}.`);
  }
}
