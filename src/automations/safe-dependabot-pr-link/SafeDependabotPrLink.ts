import type { RepositoryCoordinates } from '../../github/IssueRepository.js';
import type { ProjectStatusGateway, ProjectStatusMetadata } from '../../github/ProjectV2Repository.js';
import type { PullRequestListGateway, PullRequestRecord } from '../../github/PullRequestRepository.js';
import type { Logger } from '../../runtime/Logger.js';

export interface SafeDependabotPrLinkInput {
  projectOwner: string;
  projectNumber: number;
  repositories: string;
  repositoriesJson: string;
  defaultRepositoryOwner: string;
  statusFieldName: string;
  statusStartValue: string;
  statusFinalValue: string;
  dependabotLogin: string;
  maxPullRequestsPerRepo: number;
  closedLookbackDays: number;
}

interface NamedRepository extends RepositoryCoordinates {
  nameWithOwner: string;
}

interface Counters {
  added: number;
  updated: number;
  unchanged: number;
  openSeen: number;
  closedSeen: number;
}

export class SafeDependabotPrLink {
  constructor(
    private readonly pullRequests: PullRequestListGateway,
    private readonly projects: ProjectStatusGateway,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(input: SafeDependabotPrLinkInput): Promise<Counters> {
    validateInput(input);
    const repositories = parseRepositories(
      input.repositories,
      input.repositoriesJson,
      input.defaultRepositoryOwner,
      this.logger,
    );
    const project = await this.projects.getStatusMetadata(
      input.projectOwner,
      input.projectNumber,
      input.statusFieldName,
    );
    const startOptionId = project.optionIdsByName.get(input.statusStartValue);
    const finalOptionId = project.optionIdsByName.get(input.statusFinalValue);
    if (!startOptionId || !finalOptionId) {
      throw new Error(`Required status options were not found in field ${input.statusFieldName}.`);
    }

    this.logger.info(`Resolved project "${project.projectTitle}" (${input.projectOwner}#${input.projectNumber}).`);
    const counters: Counters = { added: 0, updated: 0, unchanged: 0, openSeen: 0, closedSeen: 0 };
    const cutoff = getClosedCutoffDate(input.closedLookbackDays, this.now());

    for (const repository of repositories) {
      const openPullRequests = await this.listDependabotPullRequests(repository, 'open', null, input);
      counters.openSeen += openPullRequests.length;
      for (const pullRequest of openPullRequests) {
        await this.reconcile(repository, pullRequest, input.statusStartValue, startOptionId, project, input, counters);
      }

      const closedPullRequests = await this.listDependabotPullRequests(repository, 'closed', cutoff, input);
      counters.closedSeen += closedPullRequests.length;
      for (const pullRequest of closedPullRequests) {
        await this.reconcile(repository, pullRequest, input.statusFinalValue, finalOptionId, project, input, counters);
      }
    }

    this.logger.info(
      `Dependabot reconciliation complete. Open seen: ${counters.openSeen}. Closed seen: ${counters.closedSeen}. Added: ${counters.added}. Updated: ${counters.updated}. Unchanged: ${counters.unchanged}.`,
    );
    return counters;
  }

  private async listDependabotPullRequests(
    repository: NamedRepository,
    state: 'open' | 'closed',
    cutoff: Date | null,
    input: SafeDependabotPrLinkInput,
  ): Promise<PullRequestRecord[]> {
    const result: PullRequestRecord[] = [];
    const perPage = Math.min(100, input.maxPullRequestsPerRepo);

    for (let page = 1; result.length < input.maxPullRequestsPerRepo; page += 1) {
      const pageItems = await this.pullRequests.listPullRequests(repository, state, page, perPage);
      if (pageItems.length === 0) break;
      let reachedCutoff = false;

      for (const pullRequest of pageItems) {
        if (state === 'closed' && cutoff && new Date(pullRequest.updatedAt) < cutoff) {
          reachedCutoff = true;
          break;
        }
        if (pullRequest.authorLogin === input.dependabotLogin) result.push(pullRequest);
        if (result.length >= input.maxPullRequestsPerRepo) break;
      }
      if (pageItems.length < perPage || reachedCutoff) break;
    }
    return result;
  }

  private async reconcile(
    repository: NamedRepository,
    pullRequest: PullRequestRecord,
    targetStatusName: string,
    targetOptionId: string,
    project: ProjectStatusMetadata,
    input: SafeDependabotPrLinkInput,
    counters: Counters,
  ): Promise<void> {
    let projectItem = await this.projects.getContentProjectItem(
      pullRequest.nodeId,
      project.projectId,
      input.statusFieldName,
    );
    let itemId = projectItem?.id;
    let currentStatus = projectItem?.statusName ?? null;
    if (!itemId) {
      itemId = await this.projects.addContentToProject(project.projectId, pullRequest.nodeId);
      currentStatus = null;
      counters.added += 1;
      this.logger.info(
        `Added ${repository.nameWithOwner}#${pullRequest.number} to project ${input.projectOwner}#${input.projectNumber}.`,
      );
    }

    if (currentStatus === targetStatusName) {
      counters.unchanged += 1;
      return;
    }
    await this.projects.setSingleSelect(project.projectId, itemId, project.statusFieldId, targetOptionId);
    counters.updated += 1;
    this.logger.info(
      `Set status ${input.statusFieldName}=${targetStatusName} for ${repository.nameWithOwner}#${pullRequest.number}.`,
    );
  }
}

export function parseRepositories(
  repositories: string,
  repositoriesJson: string,
  ownerFallback: string,
  logger: Logger,
): NamedRepository[] {
  const textEntries = repositories.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry && !entry.startsWith('#'));
  let entries: unknown[] = textEntries;
  if (entries.length === 0) {
    if (!repositoriesJson.trim()) throw new Error('Either repositories or repositories_json must be provided.');
    try {
      const parsed: unknown = JSON.parse(repositoriesJson);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('repositories_json must be a non-empty JSON array when repositories is not provided.');
      }
      entries = parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`repositories_json must be a valid JSON array: ${error.message}`);
      }
      throw error;
    }
  } else if (repositoriesJson.trim()) {
    logger.warning('Both repositories and deprecated repositories_json were provided. Using repositories.');
  }

  const unique = new Map<string, NamedRepository>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('Each repository entry must be a non-empty string.');
    }
    const parts = entry.split('/').filter(Boolean);
    const owner = parts.length === 1 ? ownerFallback : parts[0];
    const repo = parts.length === 1 ? parts[0] : parts[1];
    if (!owner || !repo || parts.length > 2) throw new Error(`Invalid repository entry: ${entry}`);
    unique.set(`${owner}/${repo}`, { owner, repo, nameWithOwner: `${owner}/${repo}` });
  }
  return [...unique.values()];
}

function getClosedCutoffDate(days: number, now: Date): Date | null {
  if (days < 0) return null;
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff;
}

function validateInput(input: SafeDependabotPrLinkInput): void {
  if (!Number.isInteger(input.projectNumber) || input.projectNumber <= 0) throw new Error('project_number must be positive.');
  if (!Number.isInteger(input.maxPullRequestsPerRepo) || input.maxPullRequestsPerRepo <= 0) {
    throw new Error('max_pull_requests_per_repo must be positive.');
  }
}
