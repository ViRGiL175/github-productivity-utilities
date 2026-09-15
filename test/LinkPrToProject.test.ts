import { describe, expect, it, vi } from 'vitest';
import { LinkPrToProject } from '../src/automations/link-pr-to-project/LinkPrToProject.js';
import type { IssueReader } from '../src/github/IssueRepository.js';
import type { ProjectStatusGateway, ProjectV2Gateway } from '../src/github/ProjectV2Repository.js';
import type { PullRequestMutationGateway } from '../src/github/PullRequestRepository.js';
import type { Logger } from '../src/runtime/Logger.js';

const input = {
  projectOwner: 'owner',
  projectNumber: 10,
  backlogRepository: { owner: 'owner', repo: 'backlog' },
  iterationFieldName: 'Iteration',
  statusFieldName: 'Status',
  statusDoneValue: 'Done',
  statusInProgressValue: 'In progress',
  statusInReviewValue: 'In review',
  pullRequestNodeId: 'PR_NODE',
  pullRequestNumber: 7,
  pullRequestRepository: { owner: 'owner', repo: 'service' },
  pullRequestBodyHint: '',
  headRef: '42-feature',
  action: 'opened',
  requestedReviewersJson: '[]',
};

function createDependencies() {
  const issues: IssueReader = {
    getIssue: vi.fn().mockResolvedValue({
      id: 42, nodeId: 'ISSUE_NODE', number: 42,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog', isPullRequest: false,
    }),
    getParentIssue: vi.fn(),
  };
  const pullRequests: PullRequestMutationGateway = {
    getPullRequestBody: vi.fn().mockResolvedValue('Description'),
    updatePullRequestBody: vi.fn().mockResolvedValue(undefined),
    getAssigneeLogins: vi.fn().mockResolvedValue([]),
    listAssignableLogins: vi.fn().mockResolvedValue(new Set()),
    setAssignees: vi.fn().mockResolvedValue(undefined),
    getUserType: vi.fn().mockResolvedValue('User'),
  };
  const projects: ProjectV2Gateway & ProjectStatusGateway = {
    getProjectMetadata: vi.fn().mockResolvedValue({ projectId: 'PROJECT', iterationFieldId: 'ITERATION_FIELD' }),
    getStatusMetadata: vi.fn().mockResolvedValue({
      projectId: 'PROJECT', projectTitle: 'Project', statusFieldId: 'STATUS_FIELD',
      optionIdsByName: new Map([['Done', 'DONE'], ['In progress', 'PROGRESS'], ['In review', 'REVIEW']]),
    }),
    getIssueProjectItem: vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ISSUE_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' }),
    addIssueToProject: vi.fn().mockResolvedValue('PR_ITEM'),
    setIteration: vi.fn().mockResolvedValue(undefined),
    getContentProjectItem: vi.fn().mockResolvedValue({ id: 'PR_ITEM', statusName: null, statusOptionId: null }),
    addContentToProject: vi.fn().mockResolvedValue('PR_ITEM'),
    setSingleSelect: vi.fn().mockResolvedValue(undefined),
  };
  const logger: Logger = { info: vi.fn(), warning: vi.fn() };
  return { issues, pullRequests, projects, logger };
}

describe('LinkPrToProject', () => {
  it('adds an opened PR, copies the sprint and appends the closing reference', async () => {
    const dependencies = createDependencies();
    await new LinkPrToProject(
      dependencies.issues,
      dependencies.pullRequests,
      dependencies.projects,
      dependencies.logger,
    ).run(input);

    expect(dependencies.projects.addIssueToProject).toHaveBeenCalledWith('PROJECT', 'PR_NODE');
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'PROGRESS');
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'SPRINT');
    expect(dependencies.pullRequests.updatePullRequestBody).toHaveBeenCalledWith(
      input.pullRequestRepository, 7, expect.stringContaining('Closes owner/backlog#42'),
    );
  });

  it('marks an existing project item done when the PR closes', async () => {
    const dependencies = createDependencies();
    await new LinkPrToProject(dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger).run({
      ...input, action: 'closed',
    });
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'DONE');
  });

  it('moves an existing item to review only for human reviewers', async () => {
    const dependencies = createDependencies();
    await new LinkPrToProject(dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger).run({
      ...input, action: 'review_requested', requestedReviewersJson: '[{"login":"reviewer","type":"User"}]',
    });
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'REVIEW');
  });

  it('stops after project linking when the branch has no issue prefix', async () => {
    const dependencies = createDependencies();
    await new LinkPrToProject(dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger).run({
      ...input, headRef: 'feature',
    });
    expect(dependencies.issues.getIssue).not.toHaveBeenCalled();
    expect(dependencies.pullRequests.updatePullRequestBody).not.toHaveBeenCalled();
  });
});
