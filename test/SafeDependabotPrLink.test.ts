import { describe, expect, it, vi } from 'vitest';
import {
  SafeDependabotPrLink,
  parseRepositories,
} from '../src/automations/safe-dependabot-pr-link/SafeDependabotPrLink.js';
import type { ProjectStatusGateway } from '../src/github/ProjectV2Repository.js';
import type { PullRequestListGateway } from '../src/github/PullRequestRepository.js';
import type { Logger } from '../src/runtime/Logger.js';

const logger: Logger = { info: vi.fn(), warning: vi.fn() };
const input = {
  projectOwner: 'owner',
  projectNumber: 10,
  repositories: 'service',
  repositoriesJson: '',
  defaultRepositoryOwner: 'owner',
  statusFieldName: 'Status',
  statusStartValue: 'To do',
  statusFinalValue: 'Done',
  dependabotLogin: 'dependabot[bot]',
  maxPullRequestsPerRepo: 50,
  closedLookbackDays: 30,
};

function createDependencies(existingStatus: string | null = null) {
  const pullRequests: PullRequestListGateway = {
    listPullRequests: vi.fn().mockImplementation(async (_repository, state, page) => {
      if (page > 1 || state === 'closed') return [];
      return [{ nodeId: 'PR', number: 12, updatedAt: '2026-09-14T00:00:00Z', authorLogin: 'dependabot[bot]' }];
    }),
  };
  const projects: ProjectStatusGateway = {
    getStatusMetadata: vi.fn().mockResolvedValue({
      projectId: 'PROJECT',
      projectTitle: 'Project',
      statusFieldId: 'FIELD',
      optionIdsByName: new Map([['To do', 'TODO'], ['Done', 'DONE']]),
    }),
    getContentProjectItem: vi.fn().mockResolvedValue(
      existingStatus === null ? null : { id: 'ITEM', statusName: existingStatus, statusOptionId: null },
    ),
    addContentToProject: vi.fn().mockResolvedValue('ITEM'),
    setSingleSelect: vi.fn().mockResolvedValue(undefined),
  };
  return { pullRequests, projects };
}

describe('SafeDependabotPrLink', () => {
  it('parses, qualifies and deduplicates repository inputs', () => {
    expect(parseRepositories('service\nowner/service\n# comment', '', 'owner', logger)).toEqual([
      { owner: 'owner', repo: 'service', nameWithOwner: 'owner/service' },
    ]);
  });

  it('adds a missing Dependabot PR and sets the open status', async () => {
    const dependencies = createDependencies();
    const counters = await new SafeDependabotPrLink(
      dependencies.pullRequests,
      dependencies.projects,
      logger,
      () => new Date('2026-09-15T00:00:00Z'),
    ).run(input);

    expect(dependencies.projects.addContentToProject).toHaveBeenCalledWith('PROJECT', 'PR');
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'ITEM', 'FIELD', 'TODO');
    expect(counters).toMatchObject({ added: 1, updated: 1, openSeen: 1 });
  });

  it('does not write when the project status is already correct', async () => {
    const dependencies = createDependencies('To do');
    const counters = await new SafeDependabotPrLink(
      dependencies.pullRequests,
      dependencies.projects,
      logger,
    ).run(input);

    expect(dependencies.projects.addContentToProject).not.toHaveBeenCalled();
    expect(dependencies.projects.setSingleSelect).not.toHaveBeenCalled();
    expect(counters.unchanged).toBe(1);
  });

  it('ignores pull requests from other authors', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listPullRequests).mockResolvedValueOnce([
      { nodeId: 'PR', number: 12, updatedAt: '2026-09-14T00:00:00Z', authorLogin: 'someone' },
    ]).mockResolvedValue([]);
    await new SafeDependabotPrLink(dependencies.pullRequests, dependencies.projects, logger).run(input);

    expect(dependencies.projects.getContentProjectItem).not.toHaveBeenCalled();
  });
});
