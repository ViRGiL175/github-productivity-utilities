import { describe, expect, it, vi } from 'vitest';
import { reconcileOpenPrSprints } from '../src/automations/link-pr-to-project/ReconcileOpenPrSprints.js';
import type { IssueManagedCommentGateway, IssueReader } from '../src/github/IssueRepository.js';
import type { ProjectIterationGateway, ProjectV2Gateway } from '../src/github/ProjectV2Repository.js';
import type { PullRequestClosingIssuesGateway, PullRequestListGateway, PullRequestMutationGateway } from '../src/github/PullRequestRepository.js';
import type { Logger } from '../src/runtime/Logger.js';

describe('ReconcileOpenPrSprints', () => {
  it('scans configured repositories without adding unrelated PRs or changing their statuses', async () => {
    const issues = {} as IssueReader & IssueManagedCommentGateway;
    const pullRequests = {
      listPullRequests: vi.fn().mockImplementation(async (_repository, _state, page) => page === 1
        ? [{ nodeId: 'PR', number: 7, updatedAt: '2026-09-23T00:00:00Z', authorLogin: 'author', body: '', headRef: '' }]
        : []),
      listClosingIssues: vi.fn(),
      getPullRequestBody: vi.fn(),
    } as PullRequestListGateway & PullRequestClosingIssuesGateway & Pick<PullRequestMutationGateway, 'getPullRequestBody'>;
    const projects = {
      getProjectMetadata: vi.fn().mockResolvedValue({ projectId: 'PROJECT', iterationFieldId: 'SPRINT_FIELD' }),
      getIssueProjectItem: vi.fn().mockResolvedValue(null),
      addIssueToProject: vi.fn(),
      setIteration: vi.fn(),
      getIterationMetadata: vi.fn(),
    } as ProjectV2Gateway & Pick<ProjectIterationGateway, 'getIterationMetadata'>;
    const logger: Logger = { info: vi.fn(), warning: vi.fn() };

    await reconcileOpenPrSprints({
      projectOwner: 'owner', projectNumber: 4, backlogRepository: { owner: 'owner', repo: 'backlog' },
      iterationFieldName: 'Sprint', repositories: 'owner/client\nowner/server',
    }, issues, pullRequests, projects, logger);

    expect(pullRequests.listPullRequests).toHaveBeenCalledTimes(2);
    expect(projects.addIssueToProject).not.toHaveBeenCalled();
    expect(projects.setIteration).not.toHaveBeenCalled();
    expect(pullRequests.listClosingIssues).not.toHaveBeenCalled();
  });
});
