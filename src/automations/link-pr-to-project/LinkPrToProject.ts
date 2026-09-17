import type { IssueClosingPullRequestsGateway, IssueReader, RepositoryCoordinates } from '../../github/IssueRepository.ts';
import type { ProjectStatusGateway, ProjectV2Gateway } from '../../github/ProjectV2Repository.ts';
import type { PullRequestMutationGateway } from '../../github/PullRequestRepository.ts';
import type { Logger } from '../../runtime/Logger.ts';

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
  reviewState?: string;
  reviewActorLogin?: string;
  reviewActorType?: string;
  requestedReviewersJson: string;
}

type ProjectGateway = ProjectV2Gateway & ProjectStatusGateway;

export async function linkPrToProject(
input: LinkPrToProjectInput,
issues: IssueReader & IssueClosingPullRequestsGateway,
pullRequests: PullRequestMutationGateway,
projects: ProjectGateway,
logger: Logger,
): Promise<void> {
  validateInput(input);
  const [iterationMetadata, statusMetadata] = await Promise.all([
    projects.getProjectMetadata(input.projectOwner, input.projectNumber, input.iterationFieldName),
    projects.getStatusMetadata(input.projectOwner, input.projectNumber, input.statusFieldName),
  ]);
  if (iterationMetadata.projectId !== statusMetadata.projectId) throw new Error('Resolved project metadata is inconsistent.');
  const doneOptionId = statusMetadata.optionIdsByName.get(input.statusDoneValue);
  if (!doneOptionId) {
    throw new Error(`Status option "${input.statusDoneValue}" was not found in field ${input.statusFieldName} of project ${input.projectOwner}#${input.projectNumber}.`);
  }
  const inProgressOptionId = optionalStatusOption(input.statusInProgressValue, input, statusMetadata.optionIdsByName, logger);
  const inReviewOptionId = optionalStatusOption(input.statusInReviewValue, input, statusMetadata.optionIdsByName, logger);
  logger.info(`Resolved project "${statusMetadata.projectTitle}" (${input.projectOwner}#${input.projectNumber}).`);

  if (input.action === 'closed') {
    const item = await projects.getContentProjectItem(
      input.pullRequestNodeId,
      statusMetadata.projectId,
      input.statusFieldName,
    );
    if (!item) {
      logger.info(`Pull request #${input.pullRequestNumber} is not in project ${input.projectOwner}#${input.projectNumber}. Nothing to mark as done.`);
      return;
    }
    await projects.setSingleSelect(statusMetadata.projectId, item.id, statusMetadata.statusFieldId, doneOptionId);
    logger.info(`Set status ${input.statusFieldName}=${input.statusDoneValue} for PR #${input.pullRequestNumber}.`);
    return;
  }

  if (input.action === 'review_requested') {
    await handleReviewRequested(input, statusMetadata.projectId, statusMetadata.statusFieldId, inReviewOptionId, pullRequests, projects, logger);
    await syncReviewAssignees(input, pullRequests, logger);
    await syncLinkedIssueReviewStatus(input, issues, projects, statusMetadata.projectId, statusMetadata.statusFieldId, inReviewOptionId, logger);
    return;
  }

  if (['review_request_removed', 'submitted', 'dismissed'].includes(input.action)) {
    if (input.action === 'submitted' && input.reviewState?.toLowerCase() === 'commented') {
      logger.info('Comment-only review does not change assignees.');
      return;
    }
    await syncReviewAssignees(input, pullRequests, logger);
    return;
  }

  let projectItem = await projects.getIssueProjectItem(
    input.pullRequestNodeId,
    iterationMetadata.projectId,
    input.iterationFieldName,
  );
  let itemId = projectItem?.id;
  const wasJustAdded = !itemId;
  if (!itemId) {
    itemId = await projects.addIssueToProject(iterationMetadata.projectId, input.pullRequestNodeId);
    projectItem = { id: itemId, iterationId: null, iterationTitle: '' };
    logger.info(`Added PR #${input.pullRequestNumber} to project ${input.projectOwner}#${input.projectNumber}.`);
  } else {
    logger.info(`PR #${input.pullRequestNumber} is already in project ${input.projectOwner}#${input.projectNumber}.`);
  }

  if (wasJustAdded && inProgressOptionId) {
    await projects.setSingleSelect(statusMetadata.projectId, itemId, statusMetadata.statusFieldId, inProgressOptionId);
    logger.info(`Set status ${input.statusFieldName}=${input.statusInProgressValue} for PR #${input.pullRequestNumber}.`);
  }

  const issueNumber = extractIssueNumber(input.headRef);
  if (!issueNumber) {
    logger.info(`Could not extract issue number from branch "${input.headRef}". Skipping sprint sync and closing reference.`);
    return;
  }

  await syncAssignees(input, issueNumber, pullRequests, logger);
  const issue = await issues.getIssue(input.backlogRepository, issueNumber);
  const issueItem = await projects.getIssueProjectItem(
    issue.nodeId,
    iterationMetadata.projectId,
    input.iterationFieldName,
  );
  if (!issueItem) {
    logger.info(`Issue #${issueNumber} is not in project ${input.projectOwner}#${input.projectNumber}.`);
  } else if (!issueItem.iterationId) {
    logger.info(`Issue #${issueNumber} has no value in field ${input.iterationFieldName}.`);
  } else if (projectItem?.iterationId === issueItem.iterationId) {
    logger.info(`PR #${input.pullRequestNumber} already has sprint ${issueItem.iterationTitle || issueItem.iterationId}.`);
  } else {
    await projects.setIteration(iterationMetadata.projectId, itemId, iterationMetadata.iterationFieldId, issueItem.iterationId);
    logger.info(`Copied sprint ${issueItem.iterationTitle || issueItem.iterationId} from issue #${issueNumber} to PR #${input.pullRequestNumber}.`);
  }
  await appendClosingReference(input, issueNumber, pullRequests);
}

function optionalStatusOption(
    name: string,
    input: LinkPrToProjectInput,
    options: ReadonlyMap<string, string>,
    logger: Logger,
  ): string | null {
    if (!name) return null;
    const option = options.get(name) ?? null;
    if (!option) logger.warning(`Status option "${name}" was not found in field ${input.statusFieldName}; status update will be skipped.`);
    return option;
}

async function handleReviewRequested(
    input: LinkPrToProjectInput,
    projectId: string,
    statusFieldId: string,
    inReviewOptionId: string | null,
    pullRequests: PullRequestMutationGateway,
    projects: ProjectGateway,
    logger: Logger,
  ): Promise<void> {
    if (!inReviewOptionId) {
      logger.info('status_in_review_value is not configured or not found; skipping.');
      return;
    }
    const reviewers = parseRequestedReviewers(input.requestedReviewersJson);
    const humanReviewers: string[] = [];
    for (const reviewer of reviewers) {
      if (!reviewer.login) {
        logger.info('Skipping reviewer without a login field.');
        continue;
      }
      const userType = reviewer.type || await pullRequests.getUserType(reviewer.login);
      if (userType === 'User') humanReviewers.push(reviewer.login);
      else logger.info(`Skipping reviewer @${reviewer.login} (type: ${userType || 'unknown'}).`);
    }
    if (humanReviewers.length === 0) {
      logger.info('No human reviewers requested; skipping status update.');
      return;
    }
    const item = await projects.getContentProjectItem(input.pullRequestNodeId, projectId, input.statusFieldName);
    if (!item) {
      logger.info(`Pull request #${input.pullRequestNumber} is not in project ${input.projectOwner}#${input.projectNumber}. Nothing to update.`);
      return;
    }
    await projects.setSingleSelect(projectId, item.id, statusFieldId, inReviewOptionId);
    logger.info(`Set status ${input.statusFieldName}=${input.statusInReviewValue} for PR #${input.pullRequestNumber} (reviewers: ${humanReviewers.join(', ')}).`);
}

async function syncAssignees(input: LinkPrToProjectInput, issueNumber: number, pullRequests: PullRequestMutationGateway, logger: Logger): Promise<void> {
    const current = await pullRequests.getAssigneeLogins(input.pullRequestRepository, input.pullRequestNumber);
    if (current.length > 0) {
      logger.info(`PR #${input.pullRequestNumber} already has assignees (${current.join(', ')}). Skipping assignee sync.`);
      return;
    }
    const issueAssignees = await pullRequests.getAssigneeLogins(input.backlogRepository, issueNumber);
    if (issueAssignees.length === 0) return;
    const assignable = await pullRequests.listAssignableLogins(input.pullRequestRepository);
    const toCopy = [...new Set(issueAssignees)].filter((login) => assignable.has(login));
    if (toCopy.length === 0) return;
    try {
      await pullRequests.setAssignees(input.pullRequestRepository, input.pullRequestNumber, toCopy);
    } catch (error) {
      if (getHttpStatus(error) === 403) {
        throw new Error(`Failed to sync assignees to PR #${input.pullRequestNumber}: token needs issues:write access on ${input.pullRequestRepository.owner}/${input.pullRequestRepository.repo}.`);
      }
      throw error;
    }
    logger.info(`Copied assignees ${toCopy.join(', ')} from issue #${issueNumber} to PR #${input.pullRequestNumber}.`);
}

async function syncReviewAssignees(input: LinkPrToProjectInput, pullRequests: PullRequestMutationGateway, logger: Logger): Promise<void> {
  const repository = input.pullRequestRepository;
  const state = await pullRequests.getReviewState(repository, input.pullRequestNumber);
  const assignable = await pullRequests.listAssignableLogins(repository);
  const reviewers = [...new Set(state.requestedReviewers
    .filter((user) => user.type === 'User' && assignable.has(user.login))
    .map((user) => user.login))];
  const current = await pullRequests.getAssigneeLogins(repository, input.pullRequestNumber);
  const actor = input.reviewActorLogin;
  const actorType = actor ? (input.reviewActorType || await pullRequests.getUserType(actor)) : null;
  if (actor && actorType !== 'User') {
    logger.info(`Review actor @${actor} is not a human user; assignees are unchanged.`);
    return;
  }
  let desired: string[];
  if (input.action === 'review_requested') {
    const requested = [...new Set([...reviewers, ...(actor && assignable.has(actor) ? [actor] : [])])];
    if (requested.length === 0) {
      logger.info(`No assignable human reviewers requested for PR #${input.pullRequestNumber}; assignees are unchanged.`);
      return;
    }
    desired = [...new Set([...current.filter((login) => login !== state.author), ...requested])];
  } else {
    if (!actor) {
      logger.info('Review actor is missing; refusing to remove an assignee.');
      return;
    }
    desired = current.filter((login) => login !== actor);
    const remainingReviewers = reviewers.filter((login) => login !== actor);
    if (remainingReviewers.length === 0 && state.requestedTeams === 0 && state.author &&
      assignable.has(state.author) && await pullRequests.getUserType(state.author) === 'User') {
      desired = [...new Set([...desired, state.author])];
    }
  }
  if (current.length === desired.length && current.every((login) => desired.includes(login))) {
    logger.info(`PR #${input.pullRequestNumber} already has the correct review assignees.`);
    return;
  }
  await pullRequests.setAssignees(repository, input.pullRequestNumber, desired);
  logger.info(`Set PR #${input.pullRequestNumber} assignees to ${desired.join(', ')}.`);
}

async function syncLinkedIssueReviewStatus(
  input: LinkPrToProjectInput,
  issues: IssueReader & IssueClosingPullRequestsGateway,
  projects: ProjectGateway,
  projectId: string,
  statusFieldId: string,
  inReviewOptionId: string | null,
  logger: Logger,
): Promise<void> {
  if (!inReviewOptionId) return;
  const issueNumber = extractIssueNumber(input.headRef);
  if (!issueNumber) return;
  const issue = await issues.getIssue(input.backlogRepository, issueNumber);
  if (issue.isOpen === false) return;
  const linked = await issues.listOpenClosingPullRequests(input.backlogRepository, issueNumber);
  if (!linked.some((pullRequest) => pullRequest.nodeId === input.pullRequestNodeId)) {
    logger.info(`PR #${input.pullRequestNumber} is not yet listed among closing PRs of issue #${issueNumber}; leaving its status unchanged.`);
    return;
  }
  for (const pullRequest of linked) {
    const item = await projects.getContentProjectItem(pullRequest.nodeId, projectId, input.statusFieldName);
    if (item?.statusName !== input.statusInReviewValue) {
      logger.info(`Linked PR ${pullRequest.repositoryNameWithOwner}#${pullRequest.number} is not in review; issue #${issueNumber} stays unchanged.`);
      return;
    }
  }
  const issueItem = await projects.getContentProjectItem(issue.nodeId, projectId, input.statusFieldName);
  if (!issueItem || issueItem.statusName === input.statusInReviewValue) return;
  await projects.setSingleSelect(projectId, issueItem.id, statusFieldId, inReviewOptionId);
  logger.info(`All ${linked.length} open linked PR(s) are in review; set issue #${issueNumber} status to ${input.statusInReviewValue}.`);
}

async function appendClosingReference(input: LinkPrToProjectInput, issueNumber: number, pullRequests: PullRequestMutationGateway): Promise<void> {
    const closesRef = `Closes ${input.backlogRepository.owner}/${input.backlogRepository.repo}#${issueNumber}`;
    const body = (await pullRequests.getPullRequestBody(input.pullRequestRepository, input.pullRequestNumber)) || input.pullRequestBodyHint;
    if (body.includes(closesRef)) return;
    await pullRequests.updatePullRequestBody(
      input.pullRequestRepository,
      input.pullRequestNumber,
      `${body}\n\n<!-- auto-linked -->\n${closesRef}`,
    );
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
