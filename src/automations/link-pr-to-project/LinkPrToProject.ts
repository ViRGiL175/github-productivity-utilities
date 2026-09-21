import type { IssueClosingPullRequestsGateway, IssueManagedCommentGateway, IssueReader, RepositoryCoordinates } from '../../github/IssueRepository.ts';
import type { ProjectIterationGateway, ProjectStatusGateway, ProjectV2Gateway } from '../../github/ProjectV2Repository.ts';
import type { PullRequestClosingIssuesGateway, PullRequestMutationGateway } from '../../github/PullRequestRepository.ts';
import type { Logger } from '../../runtime/Logger.ts';
import { collectClosingIssueReferences } from '../../github/ClosingReferenceParser.ts';
import { findCurrentIteration } from '../ensure-next-iteration-reminder/EnsureNextIterationReminder.ts';

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

type ProjectGateway = ProjectV2Gateway & ProjectStatusGateway & Pick<ProjectIterationGateway, 'getIterationMetadata'>;
type PullRequestGateway = PullRequestMutationGateway & PullRequestClosingIssuesGateway;
type IssueGateway = IssueReader & IssueClosingPullRequestsGateway & IssueManagedCommentGateway;

export const NO_ACTIVE_SPRINT_COMMENT_MARKER = '<!-- github-productivity-utilities:no-active-sprint -->';

export async function linkPrToProject(
input: LinkPrToProjectInput,
issues: IssueGateway,
pullRequests: PullRequestGateway,
projects: ProjectGateway,
logger: Logger,
now: () => Date = () => new Date(),
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
    const closingIssueNumbers = await resolveClosingIssueNumbers(input, pullRequests, logger);
    const branchIssueNumber = extractIssueNumber(input.headRef);
    await handleReviewRequested(input, statusMetadata.projectId, statusMetadata.statusFieldId, inReviewOptionId, pullRequests, projects, logger);
    await syncReviewAssignees(input, pullRequests, logger);
    await syncLinkedIssueReviewStatus(
      input,
      closingIssueNumbers.length > 0 ? closingIssueNumbers : branchIssueNumber ? [branchIssueNumber] : [],
      issues,
      projects,
      statusMetadata.projectId,
      statusMetadata.statusFieldId,
      inReviewOptionId,
      logger,
    );
    return;
  }

  if (['review_request_removed', 'submitted', 'dismissed'].includes(input.action)) {
    if (input.action === 'submitted' && input.reviewState?.toLowerCase() === 'commented') {
      logger.info('Comment-only review does not change assignees.');
      return;
    }
    await syncReviewAssignees(input, pullRequests, logger);
    if (input.action === 'submitted' && input.reviewState?.toLowerCase() === 'changes_requested' &&
      await isHumanReviewActor(input, pullRequests)) {
      const todoOption = findTodoStatusOption(statusMetadata.optionIdsByName);
      if (!todoOption) {
        logger.warning(`Todo status option was not found in field ${input.statusFieldName}; status update will be skipped.`);
        return;
      }
      const closingIssueNumbers = await resolveClosingIssueNumbers(input, pullRequests, logger);
      const branchIssueNumber = extractIssueNumber(input.headRef);
      await moveReviewBackToTodo(
        input,
        closingIssueNumbers.length > 0 ? closingIssueNumbers : branchIssueNumber ? [branchIssueNumber] : [],
        issues,
        projects,
        statusMetadata.projectId,
        statusMetadata.statusFieldId,
        todoOption,
        logger,
      );
    }
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

  const closingIssueNumbers = await resolveClosingIssueNumbers(input, pullRequests, logger);
  const branchIssueNumber = extractIssueNumber(input.headRef);
  const linkedIssueNumbers = closingIssueNumbers.length > 0
    ? closingIssueNumbers
    : branchIssueNumber ? [branchIssueNumber] : [];
  const hasLinkedIssue = linkedIssueNumbers.length > 0;
  const currentStatus = wasJustAdded
    ? null
    : await projects.getContentProjectItem(input.pullRequestNodeId, statusMetadata.projectId, input.statusFieldName);
  if (inProgressOptionId && (wasJustAdded || (hasLinkedIssue && canPromoteToInProgress(currentStatus?.statusName ?? null)))) {
    await projects.setSingleSelect(statusMetadata.projectId, itemId, statusMetadata.statusFieldId, inProgressOptionId);
    logger.info(`Set status ${input.statusFieldName}=${input.statusInProgressValue} for PR #${input.pullRequestNumber}.`);
  } else if (hasLinkedIssue && currentStatus?.statusName) {
    logger.info(`PR #${input.pullRequestNumber} already has status ${currentStatus.statusName}; it will not be downgraded to ${input.statusInProgressValue}.`);
  }

  if (linkedIssueNumbers.length === 0) {
    logger.info(`No backlog issue is linked to PR #${input.pullRequestNumber}. Skipping sprint and assignee sync.`);
    return;
  }

  const openIssues: Array<Awaited<ReturnType<IssueReader['getIssue']>>> = [];
  for (const linkedIssueNumber of linkedIssueNumbers) {
    const issue = await issues.getIssue(input.backlogRepository, linkedIssueNumber);
    if (issue.isOpen === false) {
      logger.info(`Ignoring closed linked issue #${linkedIssueNumber} for sprint and assignee sync.`);
      continue;
    }
    openIssues.push(issue);
  }
  const openIssueNumbers = openIssues.map((issue) => issue.number);
  const openBranchIssueNumber = branchIssueNumber && openIssueNumbers.includes(branchIssueNumber)
    ? branchIssueNumber
    : null;
  const issueNumber = selectPrimaryIssueNumber(openIssueNumbers, openBranchIssueNumber, logger);
  if (issueNumber) {
    await syncAssignees(input, issueNumber, pullRequests, logger);
  } else if (openIssueNumbers.length > 0) {
    logger.info(`No unambiguous backlog issue is available for assignee sync on PR #${input.pullRequestNumber}.`);
  }

  await syncLinkedIssueSprints(
    input, openIssues, projectItem, itemId, iterationMetadata.projectId,
    iterationMetadata.iterationFieldId, issues, projects, logger, now,
  );
  if (openIssueNumbers.length === 1 && !closingIssueNumbers.includes(openIssueNumbers[0]!)) {
    await appendClosingReference(input, openIssueNumbers[0]!, pullRequests);
  }
  await syncLinkedIssueReviewStatus(
    input,
    linkedIssueNumbers,
    issues,
    projects,
    statusMetadata.projectId,
    statusMetadata.statusFieldId,
    inReviewOptionId,
    logger,
  );
}

async function syncLinkedIssueSprints(
  input: LinkPrToProjectInput,
  openIssues: Array<Awaited<ReturnType<IssueReader['getIssue']>>>,
  pullRequestItem: Awaited<ReturnType<ProjectV2Gateway['getIssueProjectItem']>>,
  pullRequestItemId: string,
  projectId: string,
  iterationFieldId: string,
  issues: IssueManagedCommentGateway,
  projects: ProjectGateway,
  logger: Logger,
  now: () => Date,
): Promise<void> {
  const issueItems: Array<{
    issueNumber: number;
    item: NonNullable<Awaited<ReturnType<ProjectV2Gateway['getIssueProjectItem']>>>;
  }> = [];
  for (const issue of openIssues) {
    let item = await projects.getIssueProjectItem(issue.nodeId, projectId, input.iterationFieldName);
    if (!item) {
      const itemId = await projects.addIssueToProject(projectId, issue.nodeId);
      item = { id: itemId, iterationId: null, iterationTitle: '' };
      logger.info(`Added linked issue #${issue.number} to project ${input.projectOwner}#${input.projectNumber}.`);
    }
    issueItems.push({ issueNumber: issue.number, item });
  }

  const sprintItems = issueItems.filter(({ item }) => item.iterationId !== null);
  let targetSprint: { id: string; title: string } | null = null;
  if (sprintItems.length === 0) {
    const metadata = await projects.getIterationMetadata(
      input.projectOwner,
      input.projectNumber,
      input.iterationFieldName,
    );
    assertIterationMetadata(metadata, projectId, iterationFieldId);
    const active = findCurrentIteration(metadata.iterations, now());
    if (!active) {
      await commentWhenNoActiveSprint(input, openIssues.map((issue) => issue.number), issues, logger);
      return;
    }
    targetSprint = active;
  } else {
    let selected = sprintItems[0]!;
    const distinctSprintIds = new Set(sprintItems.map(({ item }) => item.iterationId));
    if (distinctSprintIds.size > 1) {
      const metadata = await projects.getIterationMetadata(
        input.projectOwner,
        input.projectNumber,
        input.iterationFieldName,
      );
      assertIterationMetadata(metadata, projectId, iterationFieldId);
      const iterationsById = new Map(metadata.iterations.map((iteration) => [iteration.id, iteration]));
      const missing = [...distinctSprintIds].filter((id) => id && !iterationsById.has(id));
      if (missing.length > 0) {
        throw new Error(`Sprint metadata is missing for linked issue iteration(s): ${missing.join(', ')}.`);
      }
      selected = sprintItems.reduce((latest, candidate) => {
        const latestStart = iterationsById.get(latest.item.iterationId!)!.startDate;
        const candidateStart = iterationsById.get(candidate.item.iterationId!)!.startDate;
        return candidateStart > latestStart ? candidate : latest;
      });
    }
    targetSprint = { id: selected.item.iterationId!, title: selected.item.iterationTitle || selected.item.iterationId! };
  }

  if (pullRequestItem?.iterationId !== targetSprint.id) {
    await projects.setIteration(projectId, pullRequestItemId, iterationFieldId, targetSprint.id);
  }
  for (const { issueNumber, item } of issueItems.filter(({ item }) => item.iterationId === null)) {
    await projects.setIteration(projectId, item.id, iterationFieldId, targetSprint.id);
    logger.info(`Assigned sprint ${targetSprint.title} to linked issue #${issueNumber}.`);
  }
  logger.info(`Assigned selected sprint ${targetSprint.title} to PR #${input.pullRequestNumber} and every open linked issue without a sprint.`);
}

function assertIterationMetadata(
  metadata: Awaited<ReturnType<ProjectIterationGateway['getIterationMetadata']>>,
  projectId: string,
  iterationFieldId: string,
): void {
  if (metadata.projectId !== projectId || metadata.iterationFieldId !== iterationFieldId) {
    throw new Error('Resolved iteration metadata is inconsistent.');
  }
}

async function commentWhenNoActiveSprint(
  input: LinkPrToProjectInput,
  issueNumbers: number[],
  issues: IssueManagedCommentGateway,
  logger: Logger,
): Promise<void> {
  const pullRequestReference = `${input.pullRequestRepository.owner}/${input.pullRequestRepository.repo}#${input.pullRequestNumber}`;
  const comment = [
    `⚠️ Задача связана с PR ${pullRequestReference}, но активный Sprint не найден. Назначь Sprint вручную.`,
    '',
    NO_ACTIVE_SPRINT_COMMENT_MARKER,
  ].join('\n');
  if (issueNumbers.length === 0) {
    logger.warning(`No open linked issues have a sprint and no active sprint was found for PR #${input.pullRequestNumber}.`);
    return;
  }
  for (const issueNumber of issueNumbers) {
    const result = await issues.upsertIssueCommentByMarker(
      input.backlogRepository,
      issueNumber,
      NO_ACTIVE_SPRINT_COMMENT_MARKER,
      comment,
    );
    logger.info(`Active sprint was not found; managed comment on issue #${issueNumber} was ${result}.`);
  }
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
    pullRequests: PullRequestGateway,
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

async function syncAssignees(input: LinkPrToProjectInput, issueNumber: number, pullRequests: PullRequestGateway, logger: Logger): Promise<void> {
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

async function syncReviewAssignees(input: LinkPrToProjectInput, pullRequests: PullRequestGateway, logger: Logger): Promise<void> {
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

async function isHumanReviewActor(input: LinkPrToProjectInput, pullRequests: PullRequestGateway): Promise<boolean> {
  if (!input.reviewActorLogin) return false;
  return (input.reviewActorType || await pullRequests.getUserType(input.reviewActorLogin)) === 'User';
}

async function syncLinkedIssueReviewStatus(
  input: LinkPrToProjectInput,
  issueNumbers: number[],
  issues: IssueGateway,
  projects: ProjectGateway,
  projectId: string,
  statusFieldId: string,
  inReviewOptionId: string | null,
  logger: Logger,
): Promise<void> {
  if (!inReviewOptionId) return;
  for (const issueNumber of [...new Set(issueNumbers)]) {
    const issue = await issues.getIssue(input.backlogRepository, issueNumber);
    if (issue.isOpen === false) continue;
    const linked = await issues.listOpenClosingPullRequests(input.backlogRepository, issueNumber);
    if (!linked.some((pullRequest) => pullRequest.nodeId === input.pullRequestNodeId)) {
      logger.info(`PR #${input.pullRequestNumber} is not yet listed among closing PRs of issue #${issueNumber}; leaving its status unchanged.`);
      continue;
    }
    let allInReview = true;
    for (const pullRequest of linked) {
      const item = await projects.getContentProjectItem(pullRequest.nodeId, projectId, input.statusFieldName);
      if (item?.statusName !== input.statusInReviewValue) {
        logger.info(`Linked PR ${pullRequest.repositoryNameWithOwner}#${pullRequest.number} is not in review; issue #${issueNumber} stays unchanged.`);
        allInReview = false;
        break;
      }
    }
    if (!allInReview) continue;
    const issueItem = await projects.getContentProjectItem(issue.nodeId, projectId, input.statusFieldName);
    if (!issueItem || issueItem.statusName === input.statusInReviewValue) continue;
    await projects.setSingleSelect(projectId, issueItem.id, statusFieldId, inReviewOptionId);
    logger.info(`All ${linked.length} open linked PR(s) are in review; set issue #${issueNumber} status to ${input.statusInReviewValue}.`);
  }
}

async function moveReviewBackToTodo(
  input: LinkPrToProjectInput,
  issueNumbers: number[],
  issues: IssueGateway,
  projects: ProjectGateway,
  projectId: string,
  statusFieldId: string,
  todoOption: { id: string; name: string },
  logger: Logger,
): Promise<void> {
  const pullRequestItem = await projects.getContentProjectItem(input.pullRequestNodeId, projectId, input.statusFieldName);
  if (pullRequestItem && pullRequestItem.statusOptionId !== todoOption.id) {
    await projects.setSingleSelect(projectId, pullRequestItem.id, statusFieldId, todoOption.id);
    logger.info(`Changes were requested; set PR #${input.pullRequestNumber} status to ${todoOption.name}.`);
  }

  for (const issueNumber of [...new Set(issueNumbers)]) {
    const issue = await issues.getIssue(input.backlogRepository, issueNumber);
    if (issue.isOpen === false) continue;
    const linked = await issues.listOpenClosingPullRequests(input.backlogRepository, issueNumber);
    if (!linked.some((pullRequest) => pullRequest.nodeId === input.pullRequestNodeId)) {
      logger.info(`PR #${input.pullRequestNumber} is not yet listed among closing PRs of issue #${issueNumber}; leaving its status unchanged.`);
      continue;
    }
    const issueItem = await projects.getContentProjectItem(issue.nodeId, projectId, input.statusFieldName);
    if (!issueItem || issueItem.statusOptionId === todoOption.id) continue;
    await projects.setSingleSelect(projectId, issueItem.id, statusFieldId, todoOption.id);
    logger.info(`Changes were requested on PR #${input.pullRequestNumber}; set issue #${issueNumber} status to ${todoOption.name}.`);
  }
}

async function appendClosingReference(input: LinkPrToProjectInput, issueNumber: number, pullRequests: PullRequestGateway): Promise<void> {
    const closesRef = `Closes ${input.backlogRepository.owner}/${input.backlogRepository.repo}#${issueNumber}`;
    const body = (await pullRequests.getPullRequestBody(input.pullRequestRepository, input.pullRequestNumber)) || input.pullRequestBodyHint;
    if (body.includes(closesRef)) return;
    await pullRequests.updatePullRequestBody(
      input.pullRequestRepository,
      input.pullRequestNumber,
      `${body}\n\n<!-- auto-linked -->\n${closesRef}`,
    );
}

async function resolveClosingIssueNumbers(
  input: LinkPrToProjectInput,
  pullRequests: PullRequestGateway,
  logger: Logger,
): Promise<number[]> {
  const references = await pullRequests.listClosingIssues(input.pullRequestRepository, input.pullRequestNumber);
  const matching = matchingBacklogIssueNumbers(references, input.backlogRepository);
  const body = input.pullRequestBodyHint
    || await pullRequests.getPullRequestBody(input.pullRequestRepository, input.pullRequestNumber);
  const bodyIssueNumbers = collectClosingIssueReferences(body, input.pullRequestRepository)
    .filter((reference) =>
      reference.repository.owner.toLowerCase() === input.backlogRepository.owner.toLowerCase()
      && reference.repository.repo.toLowerCase() === input.backlogRepository.repo.toLowerCase())
    .map((reference) => reference.number);
  const resolved = [...new Set([...matching, ...bodyIssueNumbers])];
  if (bodyIssueNumbers.length > 0 && matching.length < resolved.length) {
    logger.info(`Read closing issue reference(s) ${bodyIssueNumbers.join(', ')} from the PR body because GitHub's relationship index may be incomplete.`);
  }
  return resolved;
}

function matchingBacklogIssueNumbers(
  references: Awaited<ReturnType<PullRequestClosingIssuesGateway['listClosingIssues']>>,
  backlogRepository: RepositoryCoordinates,
): number[] {
  const expected = `${backlogRepository.owner}/${backlogRepository.repo}`.toLowerCase();
  return [...new Set(references
    .filter((reference) => reference.repositoryNameWithOwner.toLowerCase() === expected)
    .map((reference) => reference.number))];
}

function selectPrimaryIssueNumber(
  closingIssueNumbers: number[],
  branchIssueNumber: number | null,
  logger: Logger,
): number | null {
  if (closingIssueNumbers.length === 0) return branchIssueNumber;
  if (branchIssueNumber && closingIssueNumbers.includes(branchIssueNumber)) return branchIssueNumber;
  if (closingIssueNumbers.length === 1) return closingIssueNumbers[0]!;
  logger.warning(`PR has multiple closing issues in the backlog (${closingIssueNumbers.join(', ')}) and the branch does not select one; metadata sync is skipped.`);
  return null;
}

function canPromoteToInProgress(statusName: string | null): boolean {
  return statusName === null || statusName.toLowerCase().replace(/[\s_-]+/g, '') === 'todo';
}

function findTodoStatusOption(options: ReadonlyMap<string, string>): { id: string; name: string } | null {
  for (const [name, id] of options) {
    if (name.toLowerCase().replace(/[\s_-]+/g, '') === 'todo') return { id, name };
  }
  return null;
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
