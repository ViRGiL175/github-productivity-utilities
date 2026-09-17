import { describe, expect, it, vi } from 'vitest';
import { reconcileSubIssueSprints, syncSubIssueSprint } from '../src/automations/sync-sub-issue-sprint/SyncSubIssueSprint.js';
import type { SubIssueReader } from '../src/github/IssueRepository.js';
import type { ProjectIssueScanGateway } from '../src/github/ProjectV2Repository.js';
import type { IssueReader } from '../src/github/IssueRepository.js';
import type { ProjectV2Gateway } from '../src/github/ProjectV2Repository.js';
import type { Logger } from '../src/runtime/Logger.js';

const input = {
  action: 'opened',
  projectOwner: 'owner',
  projectNumber: 10,
  iterationFieldName: 'Iteration',
  issueNumber: 42,
  repository: { owner: 'owner', repo: 'backlog' },
};

function createDependencies(options: { childIterationId?: string | null } = {}) {
  const issues: IssueReader = {
    getIssue: vi.fn().mockResolvedValue({
      id: 42,
      nodeId: 'ISSUE_child',
      number: 42,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog',
      isPullRequest: false,
    }),
    getParentIssue: vi.fn().mockResolvedValue({
      id: 41,
      nodeId: 'ISSUE_parent',
      number: 41,
      repositoryUrl: 'https://api.github.com/repos/owner/backlog',
      isPullRequest: false,
    }),
  };
  const projects: ProjectV2Gateway = {
    getProjectMetadata: vi.fn().mockResolvedValue({
      projectId: 'PROJECT',
      iterationFieldId: 'FIELD',
    }),
    getIssueProjectItem: vi
      .fn()
      .mockResolvedValueOnce({ id: 'PARENT_ITEM', iterationId: 'ITERATION', iterationTitle: 'Sprint 1' })
      .mockResolvedValueOnce(
        options.childIterationId === undefined
          ? null
          : { id: 'CHILD_ITEM', iterationId: options.childIterationId, iterationTitle: '' },
      ),
    addIssueToProject: vi.fn().mockResolvedValue('CHILD_ITEM'),
    setIteration: vi.fn().mockResolvedValue(undefined),
  };
  const logger: Logger = { info: vi.fn(), warning: vi.fn() };

  return { issues, projects, logger };
}

describe('SyncSubIssueSprint', () => {
  it('adds the child to the project and copies the parent iteration', async () => {
    const dependencies = createDependencies();
    await syncSubIssueSprint(input, dependencies.issues, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.addIssueToProject).toHaveBeenCalledWith('PROJECT', 'ISSUE_child');
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith('PROJECT', 'CHILD_ITEM', 'FIELD', 'ITERATION');
  });

  it('does not write when the child already has the parent iteration', async () => {
    const dependencies = createDependencies({ childIterationId: 'ITERATION' });
    await syncSubIssueSprint(input, dependencies.issues, dependencies.projects, dependencies.logger);

    expect(dependencies.projects.addIssueToProject).not.toHaveBeenCalled();
    expect(dependencies.projects.setIteration).not.toHaveBeenCalled();
  });

  it('skips unsupported events before accessing GitHub', async () => {
    const dependencies = createDependencies();
    await syncSubIssueSprint({ ...input, action: 'edited' }, dependencies.issues, dependencies.projects, dependencies.logger);

    expect(dependencies.issues.getIssue).not.toHaveBeenCalled();
    expect(dependencies.projects.getProjectMetadata).not.toHaveBeenCalled();
  });
});

describe('ReconcileSubIssueSprints', () => {
  function reconciliationDependencies(childIterationId: string | null = null) {
    const issues: SubIssueReader & Pick<IssueReader, 'getIssue'> = {
      getIssue: vi.fn().mockResolvedValue({
        id: 41, nodeId: 'ISSUE_parent', number: 41,
        repositoryUrl: 'https://api.github.com/repos/owner/backlog', isPullRequest: false, isOpen: true,
      }),
      listSubIssues: vi.fn().mockResolvedValue([{
        id: 42, nodeId: 'ISSUE_child', number: 42,
        repositoryUrl: 'https://api.github.com/repos/owner/backlog', isPullRequest: false, isOpen: true,
      }]),
    };
    const projects = {
      getProjectMetadata: vi.fn().mockResolvedValue({ projectId: 'PROJECT', iterationFieldId: 'FIELD' }),
      listOpenIssuesWithField: vi.fn().mockResolvedValue([{
        nodeId: 'ISSUE_parent', number: 41, repositoryNameWithOwner: 'owner/backlog',
        parentNodeId: null, parentNumber: null, parentRepositoryNameWithOwner: null,
        fieldValue: null, iterationId: 'SPRINT', subIssueCount: 1,
      }]),
      getIssueProjectItem: vi.fn().mockImplementation((nodeId: string) => Promise.resolve(
        nodeId === 'ISSUE_parent'
          ? { id: 'PARENT_ITEM', iterationId: 'SPRINT', iterationTitle: 'Sprint 1' }
          : childIterationId === null ? null : { id: 'CHILD_ITEM', iterationId: childIterationId, iterationTitle: '' },
      )),
      addIssueToProject: vi.fn().mockResolvedValue('CHILD_ITEM'),
      setIteration: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProjectV2Gateway & ProjectIssueScanGateway;
    const logger: Logger = { info: vi.fn(), warning: vi.fn() };
    return { issues, projects, logger };
  }

  const reconcileInput = { projectOwner: 'owner', projectNumber: 10, iterationFieldName: 'Iteration', dryRun: false };

  it('adds an existing sub-issue to the project and inherits the current Sprint', async () => {
    const { issues, projects, logger } = reconciliationDependencies();
    await reconcileSubIssueSprints(reconcileInput, issues, projects, logger);
    expect(projects.addIssueToProject).toHaveBeenCalledWith('PROJECT', 'ISSUE_child');
    expect(projects.setIteration).toHaveBeenCalledWith('PROJECT', 'CHILD_ITEM', 'FIELD', 'SPRINT');
  });

  it('updates a child after its parent Sprint changes', async () => {
    const { issues, projects, logger } = reconciliationDependencies('OLD_SPRINT');
    await reconcileSubIssueSprints(reconcileInput, issues, projects, logger);
    expect(projects.addIssueToProject).not.toHaveBeenCalled();
    expect(projects.setIteration).toHaveBeenCalledWith('PROJECT', 'CHILD_ITEM', 'FIELD', 'SPRINT');
  });

  it('reconciles a specified parent directly even when the project scan has not indexed it', async () => {
    const { issues, projects, logger } = reconciliationDependencies('OLD_SPRINT');
    vi.mocked(projects.listOpenIssuesWithField).mockResolvedValue([]);
    await reconcileSubIssueSprints({
      ...reconcileInput, parentIssueNumber: 41, parentRepository: { owner: 'owner', repo: 'backlog' },
    }, issues, projects, logger);
    expect(projects.listOpenIssuesWithField).not.toHaveBeenCalled();
    expect(projects.setIteration).toHaveBeenCalledWith('PROJECT', 'CHILD_ITEM', 'FIELD', 'SPRINT');
  });

  it('is idempotent and supports dry-run', async () => {
    const matching = reconciliationDependencies('SPRINT');
    await reconcileSubIssueSprints(reconcileInput, matching.issues, matching.projects, matching.logger);
    expect(matching.projects.setIteration).not.toHaveBeenCalled();
    const dryRun = reconciliationDependencies();
    await reconcileSubIssueSprints({ ...reconcileInput, dryRun: true }, dryRun.issues, dryRun.projects, dryRun.logger);
    expect(dryRun.projects.addIssueToProject).not.toHaveBeenCalled();
    expect(dryRun.projects.setIteration).not.toHaveBeenCalled();
  });
});
