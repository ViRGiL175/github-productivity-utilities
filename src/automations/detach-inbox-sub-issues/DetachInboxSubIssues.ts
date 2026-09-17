import type { IssueHierarchyGateway, RepositoryCoordinates } from '../../github/IssueRepository.ts';
import { parseRepositoryUrl } from '../../github/IssueRepository.ts';
import type { Logger } from '../../runtime/Logger.ts';

const BLOCK_START = '<!-- github-productivity-utilities:former-parent:start -->';
const BLOCK_END = '<!-- github-productivity-utilities:former-parent:end -->';

export interface DetachInboxInput {
  horizonFieldName: string;
  inboxValue: string;
  issueNodeId: string;
  issueRepository: RepositoryCoordinates;
  issueNumber: number;
  previousHorizon: string;
  currentHorizon: string;
  dryRun: boolean;
}

export async function detachInboxSubIssues(
  input: DetachInboxInput,
  issues: IssueHierarchyGateway,
  logger: Logger,
): Promise<void> {
  // Initial placement in Inbox is allowed to form a temporary hierarchy.
  if (!input.previousHorizon || input.previousHorizon === input.inboxValue || input.currentHorizon !== input.inboxValue) {
    logger.info('Horizon did not move from another value into Inbox; leaving the hierarchy unchanged.');
    return;
  }
  const current = await issues.getSingleSelectFieldValue(input.issueRepository, input.issueNumber, input.horizonFieldName);
  if (current !== input.inboxValue) {
    logger.info('Issue is no longer in Inbox; ignoring the stale transition.');
    return;
  }
  const child = await issues.getIssue(input.issueRepository, input.issueNumber);
  if (child.nodeId !== input.issueNodeId || child.isPullRequest) {
    throw new Error('Inbox transition does not match the expected issue.');
  }
  if (child.isOpen === false) {
    logger.info(`Issue #${input.issueNumber} is closed; leaving its hierarchy unchanged.`);
    return;
  }
  const parent = await issues.getParentIssue(input.issueRepository, input.issueNumber);
  if (!parent) {
    logger.info(`Issue #${input.issueNumber} has no parent; nothing to detach.`);
    return;
  }
  const parentRepository = parseRepositoryUrl(parent.repositoryUrl);
  const parentHorizon = await issues.getSingleSelectFieldValue(parentRepository, parent.number, input.horizonFieldName);
  if (parentHorizon === input.inboxValue) {
    logger.info(`Parent #${parent.number} is also in Inbox; preserving the hierarchy.`);
    return;
  }
  const parentUrl = `https://github.com/${parentRepository.owner}/${parentRepository.repo}/issues/${parent.number}`;
  const body = await issues.getIssueBody(input.issueRepository, input.issueNumber);
  const updated = withFormerParentBlock(body, parentUrl);
  if (input.dryRun) {
    logger.info(`DRY RUN: would save ${parentUrl} and detach ${input.issueRepository.owner}/${input.issueRepository.repo}#${input.issueNumber}.`);
    return;
  }
  // Save the link first. A failed unlink can be retried without duplicating the block.
  if (updated !== body) await issues.updateIssueBody(input.issueRepository, input.issueNumber, updated);
  await issues.removeSubIssue(parentRepository, parent.number, child.id);
  logger.info(`Saved former parent ${parentUrl} and detached issue #${input.issueNumber}.`);
}

export function withFormerParentBlock(body: string, parentUrl: string): string {
  const block = `${BLOCK_START}\nFormer parent: ${parentUrl}\n${BLOCK_END}`;
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error('Former-parent block markers are incomplete; refusing to edit the issue body.');
  }
  if (start !== -1) {
    return body.slice(0, start) + block + body.slice(end + BLOCK_END.length);
  }
  return body ? `${body}\n\n${block}` : block;
}
