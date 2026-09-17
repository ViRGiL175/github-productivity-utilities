import type { IssueHierarchyGateway } from '../../github/IssueRepository.ts';
import type { ProjectIssueScanGateway, ProjectStatusGateway } from '../../github/ProjectV2Repository.ts';
import type { Logger } from '../../runtime/Logger.ts';

const BLOCK_START = '<!-- github-productivity-utilities:former-parent:start -->';
const BLOCK_END = '<!-- github-productivity-utilities:former-parent:end -->';

export interface DetachInboxInput {
  projectOwner: string;
  projectNumber: number;
  horizonFieldName: string;
  inboxValue: string;
  dryRun: boolean;
}

export async function detachInboxSubIssues(
  input: DetachInboxInput,
  projects: ProjectIssueScanGateway & ProjectStatusGateway,
  issues: IssueHierarchyGateway,
  logger: Logger,
): Promise<void> {
  const metadata = await projects.getStatusMetadata(input.projectOwner, input.projectNumber, input.horizonFieldName);
  if (!metadata.optionIdsByName.has(input.inboxValue)) {
    throw new Error(`Horizon option "${input.inboxValue}" was not found in ${input.projectOwner}#${input.projectNumber}.`);
  }
  const candidates = (await projects.listOpenIssuesWithField(metadata.projectId, input.horizonFieldName))
    .filter((item) => item.fieldValue === input.inboxValue && item.parentNodeId);
  const failures: string[] = [];
  for (const item of candidates) {
    const label = `${item.repositoryNameWithOwner}#${item.number}`;
    try {
      if (!item.parentNumber || !item.parentRepositoryNameWithOwner) throw new Error('Parent metadata is incomplete.');
      const childRepository = splitRepository(item.repositoryNameWithOwner);
      const parentRepository = splitRepository(item.parentRepositoryNameWithOwner);
      const [child, actualParent] = await Promise.all([
        issues.getIssue(childRepository, item.number),
        issues.getParentIssue(childRepository, item.number),
      ]);
      if (!actualParent || actualParent.nodeId !== item.parentNodeId) {
        logger.info(`Parent of ${label} changed since the project scan; skipping this run.`);
        continue;
      }
      const parentUrl = `https://github.com/${parentRepository.owner}/${parentRepository.repo}/issues/${item.parentNumber}`;
      const body = await issues.getIssueBody(childRepository, item.number);
      const updated = withFormerParentBlock(body, parentUrl);
      if (input.dryRun) {
        logger.info(`DRY RUN: would save ${parentUrl} and detach ${label}.`);
        continue;
      }
      // Save the link first. A failed unlink can be retried without duplicating the block.
      if (updated !== body) await issues.updateIssueBody(childRepository, item.number, updated);
      await issues.removeSubIssue(parentRepository, item.parentNumber, child.id);
      logger.info(`Saved former parent ${parentUrl} and detached ${label}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${label}: ${message}`);
      logger.warning(`Could not detach ${label}: ${message}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} Inbox issue(s) failed: ${failures.join('; ')}`);
  logger.info(`Scanned ${candidates.length} Inbox issue(s) with a parent.`);
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
  return body.trimEnd() ? `${body.trimEnd()}\n\n${block}` : block;
}

function splitRepository(nameWithOwner: string): { owner: string; repo: string } {
  const [owner, repo, extra] = nameWithOwner.split('/');
  if (!owner || !repo || extra) throw new Error(`Invalid repository name: ${nameWithOwner}`);
  return { owner, repo };
}
