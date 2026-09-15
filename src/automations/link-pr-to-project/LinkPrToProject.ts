import type { IssueReader, RepositoryCoordinates } from '../../github/IssueRepository.js';
import type { ProjectStatusGateway, ProjectV2Gateway } from '../../github/ProjectV2Repository.js';
import type { PullRequestMutationGateway } from '../../github/PullRequestRepository.js';
import type { Logger } from '../../runtime/Logger.js';

export interface RequestedReviewer {
  login?: string;
  type?: string;
}

export interface LinkPrToProjectInput {
  projectOwner: string;
  projectNumber: number;
  backlogRepository: RepositoryCoordinates;
  iterationFieldName: string;
  statusFieldName: string;
  statusDoneValue: string;
  statusInProgressValue: string;
  statusInReviewValue: string;
  pullRequestNodeId: string;
  pullRequestNumber: number;
  pullRequestRepository: RepositoryCoordinates;
  pullRequestBodyHint: string;
  headRef: string;
  action: string;
  requestedReviewersJson: string;
}

type ProjectGateway = ProjectV2Gateway & ProjectStatusGateway;

export class LinkPrToProject {
  constructor(
    private readonly issues: IssueReader,
    private readonly pullRequests: PullRequestMutationGateway,
    private readonly projects: ProjectGateway,
    private readonly logger: Logger,
  ) {}

  async run(input: LinkPrToProjectInput): Promise<void> {
    validateInput(input);
    const [iterationMetadata, statusMetadata] = await Promise.all([
      this.projects.getProjectMetadata(input.projectOwner, input.projectNumber, input.iterationFieldName),
      this.projects.getStatusMetadata(input.projectOwner, input.projectNumber, input.statusFieldName),
    ]);
    if (iterationMetadata.projectId !== statusMetadata.projectId) throw new Error('Resolved project metadata is inconsistent.');
    const doneOptionId = statusMetadata.optionIdsByName.get(input.statusDoneValue);
    if (!doneOptionId) {
      throw new Error(`Status option "${input.statusDoneValue}" was not found in field ${input.statusFieldName} of project ${input.projectOwner}#${input.projectNumber}.`);
    }
    const inProgressOptionId = this.optionalStatusOption(input.statusInProgressValue, input, statusMetadata.optionIdsByName);
    const inReviewOptionId = this.optionalStatusOption(input.statusInReviewValue, input, statusMetadata.optionIdsByName);
    this.logger.info(`Resolved project "${statusMetadata.projectTitle}" (${input.projectOwner}#${input.projectNumber}).`);

    if (input.action === 'closed') {
      const item = await this.projects.getContentProjectItem(
        input.pullRequestNodeId,
        statusMetadata.projectId,
        input.statusFieldName,
      );
      if (!item) {
        this.logger.info(`Pull request #${input.pullRequestNumber} is not in project ${input.projectOwner}#${input.projectNumber}. Nothing to mark as done.`);
        return;
      }
      await this.projects.setSingleSelect(statusMetadata.projectId, item.id, statusMetadata.statusFieldId, doneOptionId);
      this.logger.info(`Set status ${input.statusFieldName}=${input.statusDoneValue} for PR #${input.pullRequestNumber}.`);
      return;
    }

    if (input.action === 'review_requested') {
      await this.handleReviewRequested(input, statusMetadata.projectId, statusMetadata.statusFieldId, inReviewOptionId);
      return;
    }

    let projectItem = await this.projects.getIssueProjectItem(
      input.pullRequestNodeId,
      iterationMetadata.projectId,
      input.iterationFieldName,
    );
    let itemId = projectItem?.id;
    const wasJustAdded = !itemId;
    if (!itemId) {
      itemId = await this.projects.addIssueToProject(iterationMetadata.projectId, input.pullRequestNodeId);
      projectItem = { id: itemId, iterationId: null, iterationTitle: '' };
      this.logger.info(`Added PR #${input.pullRequestNumber} to project ${input.projectOwner}#${input.projectNumber}.`);
    } else {
      this.logger.info(`PR #${input.pullRequestNumber} is already in project ${input.projectOwner}#${input.projectNumber}.`);
    }

    if (wasJustAdded && inProgressOptionId) {
      await this.projects.setSingleSelect(statusMetadata.projectId, itemId, statusMetadata.statusFieldId, inProgressOptionId);
      this.logger.info(`Set status ${input.statusFieldName}=${input.statusInProgressValue} for PR #${input.pullRequestNumber}.`);
    }

    const issueNumber = extractIssueNumber(input.headRef);
    if (!issueNumber) {
      this.logger.info(`Could not extract issue number from branch "${input.headRef}". Skipping sprint sync and closing reference.`);
      return;
    }

    await this.syncAssignees(input, issueNumber);
    const issue = await this.issues.getIssue(input.backlogRepository, issueNumber);
    const issueItem = await this.projects.getIssueProjectItem(
      issue.nodeId,
      iterationMetadata.projectId,
      input.iterationFieldName,
    );
    if (!issueItem) {
      this.logger.info(`Issue #${issueNumber} is not in project ${input.projectOwner}#${input.projectNumber}.`);
    } else if (!issueItem.iterationId) {
      this.logger.info(`Issue #${issueNumber} has no value in field ${input.iterationFieldName}.`);
    } else if (projectItem?.iterationId === issueItem.iterationId) {
      this.logger.info(`PR #${input.pullRequestNumber} already has sprint ${issueItem.iterationTitle || issueItem.iterationId}.`);
    } else {
      await this.projects.setIteration(iterationMetadata.projectId, itemId, iterationMetadata.iterationFieldId, issueItem.iterationId);
      this.logger.info(`Copied sprint ${issueItem.iterationTitle || issueItem.iterationId} from issue #${issueNumber} to PR #${input.pullRequestNumber}.`);
    }
    await this.appendClosingReference(input, issueNumber);
  }

  private optionalStatusOption(
    name: string,
    input: LinkPrToProjectInput,
    options: ReadonlyMap<string, string>,
  ): string | null {
    if (!name) return null;
    const option = options.get(name) ?? null;
    if (!option) this.logger.warning(`Status option "${name}" was not found in field ${input.statusFieldName}; status update will be skipped.`);
    return option;
  }

  private async handleReviewRequested(
    input: LinkPrToProjectInput,
    projectId: string,
    statusFieldId: string,
    inReviewOptionId: string | null,
  ): Promise<void> {
    if (!inReviewOptionId) {
      this.logger.info('status_in_review_value is not configured or not found; skipping.');
      return;
    }
    const reviewers = parseRequestedReviewers(input.requestedReviewersJson);
    const humanReviewers: string[] = [];
    for (const reviewer of reviewers) {
      if (!reviewer.login) {
        this.logger.info('Skipping reviewer without a login field.');
        continue;
      }
      const userType = reviewer.type || await this.pullRequests.getUserType(reviewer.login);
      if (userType === 'User') humanReviewers.push(reviewer.login);
      else this.logger.info(`Skipping reviewer @${reviewer.login} (type: ${userType || 'unknown'}).`);
    }
    if (humanReviewers.length === 0) {
      this.logger.info('No human reviewers requested; skipping status update.');
      return;
    }
    const item = await this.projects.getContentProjectItem(input.pullRequestNodeId, projectId, input.statusFieldName);
    if (!item) {
      this.logger.info(`Pull request #${input.pullRequestNumber} is not in project ${input.projectOwner}#${input.projectNumber}. Nothing to update.`);
      return;
    }
    await this.projects.setSingleSelect(projectId, item.id, statusFieldId, inReviewOptionId);
    this.logger.info(`Set status ${input.statusFieldName}=${input.statusInReviewValue} for PR #${input.pullRequestNumber} (reviewers: ${humanReviewers.join(', ')}).`);
  }

  private async syncAssignees(input: LinkPrToProjectInput, issueNumber: number): Promise<void> {
    const current = await this.pullRequests.getAssigneeLogins(input.pullRequestRepository, input.pullRequestNumber);
    if (current.length > 0) {
      this.logger.info(`PR #${input.pullRequestNumber} already has assignees (${current.join(', ')}). Skipping assignee sync.`);
      return;
    }
    const issueAssignees = await this.pullRequests.getAssigneeLogins(input.backlogRepository, issueNumber);
    if (issueAssignees.length === 0) return;
    const assignable = await this.pullRequests.listAssignableLogins(input.pullRequestRepository);
    const toCopy = [...new Set(issueAssignees)].filter((login) => assignable.has(login));
    if (toCopy.length === 0) return;
    try {
      await this.pullRequests.setAssignees(input.pullRequestRepository, input.pullRequestNumber, toCopy);
    } catch (error) {
      if (getHttpStatus(error) === 403) {
        throw new Error(`Failed to sync assignees to PR #${input.pullRequestNumber}: token needs issues:write access on ${input.pullRequestRepository.owner}/${input.pullRequestRepository.repo}.`);
      }
      throw error;
    }
    this.logger.info(`Copied assignees ${toCopy.join(', ')} from issue #${issueNumber} to PR #${input.pullRequestNumber}.`);
  }

  private async appendClosingReference(input: LinkPrToProjectInput, issueNumber: number): Promise<void> {
    const closesRef = `Closes ${input.backlogRepository.owner}/${input.backlogRepository.repo}#${issueNumber}`;
    const body = (await this.pullRequests.getPullRequestBody(input.pullRequestRepository, input.pullRequestNumber)) || input.pullRequestBodyHint;
    if (body.includes(closesRef)) return;
    await this.pullRequests.updatePullRequestBody(
      input.pullRequestRepository,
      input.pullRequestNumber,
      `${body}\n\n<!-- auto-linked -->\n${closesRef}`,
    );
  }
}

export function extractIssueNumber(branchName: string): number | null {
  const match = /^(\d+)-/.exec(branchName);
  return match ? Number(match[1]) : null;
}

export function parseRequestedReviewers(value: string): RequestedReviewer[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) throw new Error('requested_reviewers_json must be a JSON array.');
    return parsed as RequestedReviewer[];
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`requested_reviewers_json must be valid JSON: ${error.message}`);
    throw error;
  }
}

function validateInput(input: LinkPrToProjectInput): void {
  if (!input.pullRequestNodeId || !Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
    throw new Error('Pull request context is required. Pass pull_request_node_id and pull_request_number, or run from a pull_request event.');
  }
  if (!input.pullRequestRepository.owner || !input.pullRequestRepository.repo) {
    throw new Error('Pull request repository context is required. Pass pull_request_repo_owner and pull_request_repo_name, or run from a pull_request event.');
  }
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}
