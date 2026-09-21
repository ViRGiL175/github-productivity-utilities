import { describe, expect, it, vi } from 'vitest';
import { linkPrToProject, NO_ACTIVE_SPRINT_COMMENT_MARKER } from '../src/automations/link-pr-to-project/LinkPrToProject.js';
import type { IssueClosingPullRequestsGateway, IssueManagedCommentGateway, IssueReader } from '../src/github/IssueRepository.js';
import type { ProjectIterationGateway, ProjectStatusGateway, ProjectV2Gateway } from '../src/github/ProjectV2Repository.js';
import type { PullRequestClosingIssuesGateway, PullRequestMutationGateway } from '../src/github/PullRequestRepository.js';
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
  const issues: IssueReader & IssueClosingPullRequestsGateway & IssueManagedCommentGateway = {
    getIssue: vi.fn().mockResolvedValue({
      id: 42, nodeId: 'ISSUE_NODE', number: 42,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog', isPullRequest: false,
    }),
    getParentIssue: vi.fn(),
    listOpenClosingPullRequests: vi.fn().mockResolvedValue([{ nodeId: 'PR_NODE', number: 7, repositoryNameWithOwner: 'owner/service' }]),
    upsertIssueCommentByMarker: vi.fn().mockResolvedValue('created'),
  };
  const pullRequests: PullRequestMutationGateway & PullRequestClosingIssuesGateway = {
    listClosingIssues: vi.fn().mockResolvedValue([]),
    getPullRequestBody: vi.fn().mockResolvedValue('Description'),
    updatePullRequestBody: vi.fn().mockResolvedValue(undefined),
    getAssigneeLogins: vi.fn().mockResolvedValue([]),
    listAssignableLogins: vi.fn().mockResolvedValue(new Set()),
    setAssignees: vi.fn().mockResolvedValue(undefined),
    getUserType: vi.fn().mockResolvedValue('User'),
    getReviewState: vi.fn().mockResolvedValue({ author: 'author', requestedReviewers: [{ login: 'reviewer', type: 'User' }], requestedTeams: 0 }),
  };
  const projects: ProjectV2Gateway & ProjectStatusGateway & Pick<ProjectIterationGateway, 'getIterationMetadata'> = {
    getProjectMetadata: vi.fn().mockResolvedValue({ projectId: 'PROJECT', iterationFieldId: 'ITERATION_FIELD' }),
    getStatusMetadata: vi.fn().mockResolvedValue({
      projectId: 'PROJECT', projectTitle: 'Project', statusFieldId: 'STATUS_FIELD',
      optionIdsByName: new Map([['To do', 'TODO'], ['Done', 'DONE'], ['In progress', 'PROGRESS'], ['In review', 'REVIEW']]),
    }),
    getIssueProjectItem: vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ISSUE_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' }),
    addIssueToProject: vi.fn().mockResolvedValue('PR_ITEM'),
    setIteration: vi.fn().mockResolvedValue(undefined),
    getContentProjectItem: vi.fn().mockResolvedValue({ id: 'PR_ITEM', statusName: null, statusOptionId: null }),
    addContentToProject: vi.fn().mockResolvedValue('PR_ITEM'),
    setSingleSelect: vi.fn().mockResolvedValue(undefined),
    getIterationMetadata: vi.fn().mockResolvedValue({
      projectId: 'PROJECT', projectTitle: 'Project', iterationFieldId: 'ITERATION_FIELD', iterations: [],
    }),
  };
  const logger: Logger = { info: vi.fn(), warning: vi.fn() };
  return { issues, pullRequests, projects, logger };
}

describe('LinkPrToProject', () => {
  it('adds an opened PR, copies the sprint and appends the closing reference', async () => {
    const dependencies = createDependencies();
    await linkPrToProject(input, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.addIssueToProject).toHaveBeenCalledWith('PROJECT', 'PR_NODE');
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'PROGRESS');
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'SPRINT');
    expect(dependencies.pullRequests.updatePullRequestBody).toHaveBeenCalledWith(
      input.pullRequestRepository, 7, expect.stringContaining('Closes owner/backlog#42'),
    );
  });

  it('marks an existing project item done when the PR closes', async () => {
    const dependencies = createDependencies();
    await linkPrToProject({
      ...input, action: 'closed',
    }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'DONE');
  });

  it('moves an existing item to review only for human reviewers', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'reviewer']));
    await linkPrToProject({
      ...input, action: 'review_requested', requestedReviewersJson: '[{"login":"reviewer","type":"User"}]',
    }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'REVIEW');
    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['reviewer']);
  });

  it('moves the linked issue to review only after every open linked PR is in review, preserving issue assignees', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'reviewer']));
    vi.mocked(dependencies.issues.listOpenClosingPullRequests).mockResolvedValue([
      { nodeId: 'PR_NODE', number: 7, repositoryNameWithOwner: 'owner/service' },
      { nodeId: 'OTHER_PR', number: 8, repositoryNameWithOwner: 'owner/service' },
    ]);
    vi.mocked(dependencies.projects.getContentProjectItem).mockImplementation(async (nodeId) =>
      nodeId === 'ISSUE_NODE'
        ? { id: 'ISSUE_ITEM', statusName: 'In progress', statusOptionId: 'PROGRESS' }
        : { id: nodeId, statusName: 'In review', statusOptionId: 'REVIEW' });
    await linkPrToProject({ ...input, action: 'review_requested', requestedReviewersJson: '[{"login":"reviewer","type":"User"}]' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'ISSUE_ITEM', 'STATUS_FIELD', 'REVIEW');
    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['reviewer']);
    expect(dependencies.pullRequests.setAssignees).not.toHaveBeenCalledWith(input.backlogRepository, 42, expect.anything());
  });

  it('leaves the issue in progress while another linked PR has not entered review', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.issues.listOpenClosingPullRequests).mockResolvedValue([
      { nodeId: 'PR_NODE', number: 7, repositoryNameWithOwner: 'owner/service' },
      { nodeId: 'OTHER_PR', number: 8, repositoryNameWithOwner: 'owner/service' },
    ]);
    vi.mocked(dependencies.projects.getContentProjectItem).mockImplementation(async (nodeId) =>
      ({ id: nodeId, statusName: nodeId === 'OTHER_PR' ? 'In progress' : 'In review', statusOptionId: null }));
    await linkPrToProject({ ...input, action: 'review_requested', requestedReviewersJson: '[{"login":"reviewer","type":"User"}]' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.projects.setSingleSelect).not.toHaveBeenCalledWith('PROJECT', 'ISSUE_ITEM', 'STATUS_FIELD', 'REVIEW');
  });

  it('waits when GitHub has not indexed the current PR as linked to the issue', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.issues.listOpenClosingPullRequests).mockResolvedValue([]);
    await linkPrToProject({ ...input, action: 'review_requested', requestedReviewersJson: '[{"login":"reviewer","type":"User"}]' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.projects.setSingleSelect).not.toHaveBeenCalledWith('PROJECT', 'ISSUE_ITEM', 'STATUS_FIELD', 'REVIEW');
  });

  it('assigns all outstanding human reviewers, ignoring bots and teams', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'alice', 'bob']));
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['author', 'contributor']);
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({
      author: 'author', requestedReviewers: [
        { login: 'alice', type: 'User' }, { login: 'bob', type: 'User' }, { login: 'bot', type: 'Bot' },
      ], requestedTeams: 1,
    });
    await linkPrToProject({ ...input, action: 'review_requested' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['contributor', 'alice', 'bob']);
  });

  it.each(['review_request_removed', 'submitted', 'dismissed'])('returns the author when review action %s leaves no reviewers', async (action) => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'reviewer']));
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['reviewer', 'contributor']);
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({
      author: 'author', requestedReviewers: [], requestedTeams: 0,
    });
    await linkPrToProject({ ...input, action, reviewActorLogin: 'reviewer', reviewActorType: 'User' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['contributor', 'author']);
    expect(dependencies.issues.getIssue).not.toHaveBeenCalled();
  });

  it('removes only the completed reviewer while another reviewer is outstanding', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'reviewer']));
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['alice', 'reviewer', 'contributor']);
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({
      author: 'author', requestedReviewers: [{ login: 'reviewer', type: 'User' }], requestedTeams: 0,
    });
    await linkPrToProject({ ...input, action: 'submitted', reviewActorLogin: 'alice', reviewActorType: 'User' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['reviewer', 'contributor']);
  });

  it('does not write again when assignees already match review state', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'reviewer']));
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['reviewer']);
    await linkPrToProject({ ...input, action: 'submitted', reviewActorLogin: 'alice', reviewActorType: 'User' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).not.toHaveBeenCalled();
  });

  it('ignores bot review completion even when no human requests remain', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['contributor']);
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({
      author: 'author', requestedReviewers: [], requestedTeams: 0,
    });
    await linkPrToProject({ ...input, action: 'submitted', reviewActorLogin: 'copilot-pull-request-reviewer[bot]', reviewActorType: 'Bot' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).not.toHaveBeenCalled();
  });

  it('uses the active sprint instead of a stale PR sprint when the linked issue has no sprint', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.projects.getIssueProjectItem)
      .mockReset()
      .mockResolvedValueOnce({ id: 'PR_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' })
      .mockResolvedValueOnce({ id: 'ISSUE_ITEM', iterationId: null, iterationTitle: '' });
    vi.mocked(dependencies.projects.getIterationMetadata).mockResolvedValue({
      projectId: 'PROJECT', projectTitle: 'Project', iterationFieldId: 'ITERATION_FIELD',
      iterations: [{ id: 'ACTIVE', title: 'Active sprint', startDate: '2026-09-14', duration: 14 }],
    });

    await linkPrToProject(input, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger,
      () => new Date('2026-09-19T12:00:00Z'));

    expect(dependencies.projects.setIteration).toHaveBeenCalledTimes(2);
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'ACTIVE');
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith('PROJECT', 'ISSUE_ITEM', 'ITERATION_FIELD', 'ACTIVE');
  });

  it('assigns the active sprint to both the issue and PR when neither has one', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.projects.getIssueProjectItem)
      .mockReset()
      .mockResolvedValueOnce({ id: 'PR_ITEM', iterationId: null, iterationTitle: '' })
      .mockResolvedValueOnce({ id: 'ISSUE_ITEM', iterationId: null, iterationTitle: '' });
    vi.mocked(dependencies.projects.getIterationMetadata).mockResolvedValue({
      projectId: 'PROJECT', projectTitle: 'Project', iterationFieldId: 'ITERATION_FIELD',
      iterations: [{ id: 'ACTIVE', title: 'Sprint 2', startDate: '2026-09-14', duration: 14 }],
    });

    await linkPrToProject(
      input, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger,
      () => new Date('2026-09-19T12:00:00Z'),
    );

    expect(dependencies.projects.setIteration).toHaveBeenNthCalledWith(1, 'PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'ACTIVE');
    expect(dependencies.projects.setIteration).toHaveBeenNthCalledWith(2, 'PROJECT', 'ISSUE_ITEM', 'ITERATION_FIELD', 'ACTIVE');
    expect(dependencies.issues.upsertIssueCommentByMarker).not.toHaveBeenCalled();
  });

  it('leaves sprint empty and writes one managed issue comment when no sprint is active', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.projects.getIssueProjectItem)
      .mockReset()
      .mockResolvedValueOnce({ id: 'PR_ITEM', iterationId: null, iterationTitle: '' })
      .mockResolvedValueOnce({ id: 'ISSUE_ITEM', iterationId: null, iterationTitle: '' });

    await linkPrToProject(
      input, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger,
      () => new Date('2026-09-19T12:00:00Z'),
    );

    expect(dependencies.projects.setIteration).not.toHaveBeenCalled();
    expect(dependencies.issues.upsertIssueCommentByMarker).toHaveBeenCalledWith(
      input.backlogRepository, 42, NO_ACTIVE_SPRINT_COMMENT_MARKER,
      expect.stringContaining('PR owner/service#7, но активный Sprint не найден'),
    );
  });

  it('selects the latest sprint from every body-linked issue when GitHub returns no indexed references', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.issues.getIssue).mockImplementation(async (_repository, issueNumber) => ({
      id: issueNumber,
      nodeId: `ISSUE_${issueNumber}`,
      number: issueNumber,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog',
      isPullRequest: false,
    }));
    vi.mocked(dependencies.projects.getIssueProjectItem).mockReset().mockImplementation(async (nodeId) => {
      if (nodeId === 'PR_NODE') return { id: 'PR_ITEM', iterationId: null, iterationTitle: '' };
      if (nodeId === 'ISSUE_1078') return { id: 'OLD_ITEM', iterationId: 'OLD', iterationTitle: 'Old sprint' };
      if (nodeId === 'ISSUE_1145') return { id: 'CURRENT_ITEM', iterationId: 'CURRENT', iterationTitle: 'Current sprint' };
      return null;
    });
    vi.mocked(dependencies.projects.getIterationMetadata).mockResolvedValue({
      projectId: 'PROJECT',
      projectTitle: 'Project',
      iterationFieldId: 'ITERATION_FIELD',
      iterations: [
        { id: 'OLD', title: 'Old sprint', startDate: '2026-07-20', duration: 14 },
        { id: 'CURRENT', title: 'Current sprint', startDate: '2026-09-14', duration: 14 },
      ],
    });

    await linkPrToProject({
      ...input,
      headRef: '1078-gff-refine-user-info-domain-architecture',
      pullRequestBodyHint: [
        'Closes https://github.com/owner/backlog/issues/1145',
        '',
        '<!-- auto-linked -->',
        'Closes owner/backlog#1078',
      ].join('\n'),
    }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.pullRequests.listClosingIssues).toHaveBeenCalledTimes(1);
    expect(dependencies.issues.getIssue).toHaveBeenCalledWith(input.backlogRepository, 1145);
    expect(dependencies.issues.getIssue).toHaveBeenCalledWith(input.backlogRepository, 1078);
    expect(dependencies.projects.setIteration).toHaveBeenCalledTimes(1);
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith(
      'PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'CURRENT',
    );
    expect(dependencies.projects.setIteration).not.toHaveBeenCalledWith(
      'PROJECT', 'OLD_ITEM', 'ITERATION_FIELD', expect.anything(),
    );
    expect(dependencies.projects.setIteration).not.toHaveBeenCalledWith(
      'PROJECT', 'CURRENT_ITEM', 'ITERATION_FIELD', expect.anything(),
    );
  });

  it('assigns the selected sprint to an open linked issue without one', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listClosingIssues).mockResolvedValue([
      { nodeId: 'ISSUE_10', number: 10, repositoryNameWithOwner: 'owner/backlog' },
      { nodeId: 'ISSUE_20', number: 20, repositoryNameWithOwner: 'owner/backlog' },
    ]);
    vi.mocked(dependencies.issues.getIssue).mockImplementation(async (_repository, issueNumber) => ({
      id: issueNumber, nodeId: `ISSUE_${issueNumber}`, number: issueNumber,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog', isPullRequest: false,
    }));
    vi.mocked(dependencies.projects.getIssueProjectItem).mockReset().mockImplementation(async (nodeId) => {
      if (nodeId === 'PR_NODE') return { id: 'PR_ITEM', iterationId: null, iterationTitle: '' };
      if (nodeId === 'ISSUE_10') return { id: 'NO_SPRINT_ITEM', iterationId: null, iterationTitle: '' };
      if (nodeId === 'ISSUE_20') return { id: 'SPRINT_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' };
      return null;
    });

    await linkPrToProject({ ...input, headRef: 'feature' },
      dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.setIteration).toHaveBeenCalledTimes(2);
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith(
      'PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'SPRINT',
    );
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith(
      'PROJECT', 'NO_SPRINT_ITEM', 'ITERATION_FIELD', 'SPRINT',
    );
    expect(dependencies.projects.getIterationMetadata).not.toHaveBeenCalled();
  });

  it('assigns the active sprint to the PR and every open linked issue without one', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listClosingIssues).mockResolvedValue([
      { nodeId: 'ISSUE_10', number: 10, repositoryNameWithOwner: 'owner/backlog' },
      { nodeId: 'ISSUE_20', number: 20, repositoryNameWithOwner: 'owner/backlog' },
    ]);
    vi.mocked(dependencies.issues.getIssue).mockImplementation(async (_repository, issueNumber) => ({
      id: issueNumber, nodeId: `ISSUE_${issueNumber}`, number: issueNumber,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog', isPullRequest: false,
    }));
    vi.mocked(dependencies.projects.getIssueProjectItem).mockReset().mockImplementation(async (nodeId) =>
      nodeId === 'PR_NODE'
        ? { id: 'PR_ITEM', iterationId: null, iterationTitle: '' }
        : { id: `${nodeId}_ITEM`, iterationId: null, iterationTitle: '' });
    vi.mocked(dependencies.projects.getIterationMetadata).mockResolvedValue({
      projectId: 'PROJECT', projectTitle: 'Project', iterationFieldId: 'ITERATION_FIELD',
      iterations: [{ id: 'ACTIVE', title: 'Active sprint', startDate: '2026-09-14', duration: 14 }],
    });

    await linkPrToProject({ ...input, headRef: 'feature' },
      dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger,
      () => new Date('2026-09-19T12:00:00Z'));

    expect(dependencies.projects.setIteration).toHaveBeenCalledTimes(3);
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith(
      'PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'ACTIVE',
    );
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith(
      'PROJECT', 'ISSUE_10_ITEM', 'ITERATION_FIELD', 'ACTIVE',
    );
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith(
      'PROJECT', 'ISSUE_20_ITEM', 'ITERATION_FIELD', 'ACTIVE',
    );
  });

  it('ignores a closed linked issue when choosing the latest sprint', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listClosingIssues).mockResolvedValue([
      { nodeId: 'CLOSED_ISSUE', number: 10, repositoryNameWithOwner: 'owner/backlog' },
      { nodeId: 'OPEN_ISSUE', number: 20, repositoryNameWithOwner: 'owner/backlog' },
    ]);
    vi.mocked(dependencies.issues.getIssue).mockImplementation(async (_repository, issueNumber) => ({
      id: issueNumber, nodeId: issueNumber === 10 ? 'CLOSED_ISSUE' : 'OPEN_ISSUE', number: issueNumber,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog', isPullRequest: false, isOpen: issueNumber !== 10,
    }));
    vi.mocked(dependencies.projects.getIssueProjectItem).mockReset().mockImplementation(async (nodeId) => {
      if (nodeId === 'PR_NODE') return { id: 'PR_ITEM', iterationId: null, iterationTitle: '' };
      if (nodeId === 'OPEN_ISSUE') return { id: 'OPEN_ITEM', iterationId: 'CURRENT', iterationTitle: 'Current sprint' };
      if (nodeId === 'CLOSED_ISSUE') return { id: 'CLOSED_ITEM', iterationId: 'FUTURE', iterationTitle: 'Future sprint' };
      return null;
    });

    await linkPrToProject({ ...input, headRef: 'feature' },
      dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.setIteration).toHaveBeenCalledTimes(1);
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith(
      'PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'CURRENT',
    );
    expect(dependencies.projects.getIssueProjectItem).not.toHaveBeenCalledWith(
      'CLOSED_ISSUE', 'PROJECT', 'Iteration',
    );
  });

  it('assigns only the PR to the active sprint when every linked issue is closed', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.issues.getIssue).mockResolvedValue({
      id: 42, nodeId: 'ISSUE_NODE', number: 42,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog', isPullRequest: false, isOpen: false,
    });
    vi.mocked(dependencies.projects.getIssueProjectItem)
      .mockReset()
      .mockResolvedValueOnce({ id: 'PR_ITEM', iterationId: null, iterationTitle: '' });
    vi.mocked(dependencies.projects.getIterationMetadata).mockResolvedValue({
      projectId: 'PROJECT', projectTitle: 'Project', iterationFieldId: 'ITERATION_FIELD',
      iterations: [{ id: 'ACTIVE', title: 'Active sprint', startDate: '2026-09-14', duration: 14 }],
    });

    await linkPrToProject(input, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger,
      () => new Date('2026-09-19T12:00:00Z'));

    expect(dependencies.projects.setIteration).toHaveBeenCalledTimes(1);
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith(
      'PROJECT', 'PR_ITEM', 'ITERATION_FIELD', 'ACTIVE',
    );
    expect(dependencies.projects.addIssueToProject).not.toHaveBeenCalled();
  });

  it('promotes an existing Todo PR when an edited body creates a closing reference', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listClosingIssues).mockResolvedValue([
      { nodeId: 'ISSUE_NODE', number: 42, repositoryNameWithOwner: 'owner/backlog' },
    ]);
    vi.mocked(dependencies.projects.getIssueProjectItem)
      .mockReset()
      .mockResolvedValueOnce({ id: 'PR_ITEM', iterationId: null, iterationTitle: '' })
      .mockResolvedValueOnce({ id: 'ISSUE_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' });
    vi.mocked(dependencies.projects.getContentProjectItem).mockResolvedValue({
      id: 'PR_ITEM', statusName: 'Todo', statusOptionId: 'TODO',
    });

    await linkPrToProject({ ...input, action: 'edited', headRef: 'feature-without-issue-prefix' },
      dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.addIssueToProject).not.toHaveBeenCalled();
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'PROGRESS');
    expect(dependencies.pullRequests.updatePullRequestBody).not.toHaveBeenCalled();
    expect(dependencies.issues.getIssue).toHaveBeenCalledWith(input.backlogRepository, 42);
  });

  it('uses the PR body immediately while GitHub indexes an edited closing reference', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listClosingIssues).mockResolvedValue([]);
    vi.mocked(dependencies.pullRequests.getPullRequestBody).mockResolvedValue('Closes owner/backlog#42');
    vi.mocked(dependencies.projects.getIssueProjectItem)
      .mockReset()
      .mockResolvedValueOnce({ id: 'PR_ITEM', iterationId: null, iterationTitle: '' })
      .mockResolvedValueOnce({ id: 'ISSUE_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' });
    vi.mocked(dependencies.projects.getContentProjectItem).mockResolvedValue({
      id: 'PR_ITEM', statusName: 'Todo', statusOptionId: 'TODO',
    });

    await linkPrToProject({ ...input, action: 'edited', headRef: 'feature-without-issue-prefix' },
      dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.pullRequests.listClosingIssues).toHaveBeenCalledTimes(1);
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'PROGRESS');
  });

  it.each(['In review', 'Done', 'Blocked'])('does not downgrade an existing PR from %s after linking', async (statusName) => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listClosingIssues).mockResolvedValue([
      { nodeId: 'ISSUE_NODE', number: 42, repositoryNameWithOwner: 'owner/backlog' },
    ]);
    vi.mocked(dependencies.projects.getIssueProjectItem)
      .mockReset()
      .mockResolvedValueOnce({ id: 'PR_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' })
      .mockResolvedValueOnce({ id: 'ISSUE_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' });
    vi.mocked(dependencies.projects.getContentProjectItem).mockResolvedValue({
      id: 'PR_ITEM', statusName, statusOptionId: 'CURRENT',
    });

    await linkPrToProject({ ...input, action: 'edited', headRef: 'feature-without-issue-prefix' },
      dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.setSingleSelect).not.toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'PROGRESS');
  });

  it('ignores closing references to issues outside the configured backlog', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listClosingIssues).mockResolvedValue([
      { nodeId: 'OTHER_ISSUE', number: 99, repositoryNameWithOwner: 'owner/other' },
    ]);
    vi.mocked(dependencies.projects.getIssueProjectItem)
      .mockReset()
      .mockResolvedValue({ id: 'PR_ITEM', iterationId: null, iterationTitle: '' });
    vi.mocked(dependencies.projects.getContentProjectItem).mockResolvedValue({
      id: 'PR_ITEM', statusName: 'Todo', statusOptionId: 'TODO',
    });

    await linkPrToProject({ ...input, action: 'edited', headRef: 'feature-without-issue-prefix' },
      dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.setSingleSelect).not.toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'PROGRESS');
    expect(dependencies.issues.getIssue).not.toHaveBeenCalled();
  });

  it('does not assign a bot PR author after the last human review ends', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({
      author: 'dependabot[bot]', requestedReviewers: [], requestedTeams: 0,
    });
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['reviewer', 'contributor']);
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['dependabot[bot]', 'reviewer', 'contributor']));
    vi.mocked(dependencies.pullRequests.getUserType).mockResolvedValue('Bot');
    await linkPrToProject({
      ...input, action: 'submitted', reviewActorLogin: 'reviewer', reviewActorType: 'User', reviewState: 'approved',
    }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['contributor']);
  });

  it('uses the review-request event actor if GitHub has not listed the new reviewer yet', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'reviewer']));
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['author', 'contributor']);
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({ author: 'author', requestedReviewers: [], requestedTeams: 0 });
    await linkPrToProject({ ...input, action: 'review_requested', reviewActorLogin: 'reviewer', reviewActorType: 'User' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['contributor', 'reviewer']);
  });

  it('returns the author when the completed reviewer is still in a stale requested-reviewers response', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'reviewer']));
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['reviewer', 'contributor']);
    await linkPrToProject({ ...input, action: 'submitted', reviewActorLogin: 'reviewer', reviewActorType: 'User', reviewState: 'approved' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['contributor', 'author']);
  });

  it('does not react to comment-only reviews', async () => {
    const dependencies = createDependencies();
    await linkPrToProject({ ...input, action: 'submitted', reviewState: 'commented' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.getReviewState).not.toHaveBeenCalled();
    expect(dependencies.pullRequests.setAssignees).not.toHaveBeenCalled();
  });

  it('returns a PR and its linked issue to Todo when changes are requested', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.listClosingIssues).mockResolvedValue([
      { nodeId: 'ISSUE_NODE', number: 42, repositoryNameWithOwner: 'owner/backlog' },
    ]);
    vi.mocked(dependencies.pullRequests.listAssignableLogins).mockResolvedValue(new Set(['author', 'reviewer']));
    vi.mocked(dependencies.pullRequests.getAssigneeLogins).mockResolvedValue(['reviewer']);
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({
      author: 'author', requestedReviewers: [], requestedTeams: 0,
    });
    vi.mocked(dependencies.projects.getContentProjectItem).mockImplementation(async (nodeId) =>
      ({ id: nodeId === 'ISSUE_NODE' ? 'ISSUE_ITEM' : 'PR_ITEM', statusName: 'In review', statusOptionId: 'REVIEW' }));

    await linkPrToProject({
      ...input,
      action: 'submitted',
      reviewState: 'changes_requested',
      reviewActorLogin: 'reviewer',
      reviewActorType: 'User',
    }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.pullRequests.setAssignees).toHaveBeenCalledWith(input.pullRequestRepository, 7, ['author']);
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'TODO');
    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'ISSUE_ITEM', 'STATUS_FIELD', 'TODO');
  });

  it('recognizes Todo regardless of spaces and letter case', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.projects.getStatusMetadata).mockResolvedValue({
      projectId: 'PROJECT', projectTitle: 'Project', statusFieldId: 'STATUS_FIELD',
      optionIdsByName: new Map([['TODO', 'TODO'], ['Done', 'DONE'], ['In progress', 'PROGRESS'], ['In review', 'REVIEW']]),
    });
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({
      author: 'author', requestedReviewers: [], requestedTeams: 0,
    });
    vi.mocked(dependencies.projects.getContentProjectItem).mockResolvedValue({
      id: 'PR_ITEM', statusName: 'In review', statusOptionId: 'REVIEW',
    });

    await linkPrToProject({
      ...input,
      headRef: 'feature',
      action: 'submitted',
      reviewState: 'changes_requested',
      reviewActorLogin: 'reviewer',
      reviewActorType: 'User',
    }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.setSingleSelect).toHaveBeenCalledWith('PROJECT', 'PR_ITEM', 'STATUS_FIELD', 'TODO');
  });

  it('does not return a PR to Todo for bot review changes', async () => {
    const dependencies = createDependencies();

    await linkPrToProject({
      ...input,
      headRef: 'feature',
      action: 'submitted',
      reviewState: 'changes_requested',
      reviewActorLogin: 'review-bot[bot]',
      reviewActorType: 'Bot',
    }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.getContentProjectItem).not.toHaveBeenCalled();
    expect(dependencies.projects.setSingleSelect).not.toHaveBeenCalled();
  });

  it('does not assign the author when only a team review is pending', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.pullRequests.getReviewState).mockResolvedValue({
      author: 'author', requestedReviewers: [], requestedTeams: 1,
    });
    await linkPrToProject({ ...input, action: 'review_requested' }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.pullRequests.setAssignees).not.toHaveBeenCalled();
  });

  it('stops after project linking when the branch has no issue prefix', async () => {
    const dependencies = createDependencies();
    await linkPrToProject({
      ...input, headRef: 'feature',
    }, dependencies.issues, dependencies.pullRequests, dependencies.projects, dependencies.logger);
    expect(dependencies.issues.getIssue).not.toHaveBeenCalled();
    expect(dependencies.pullRequests.updatePullRequestBody).not.toHaveBeenCalled();
  });
});
