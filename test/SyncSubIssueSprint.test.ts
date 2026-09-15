import { describe, expect, it, vi } from 'vitest';
import { SyncSubIssueSprint } from '../src/automations/sync-sub-issue-sprint/SyncSubIssueSprint.js';
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
  const logger: Logger = { info: vi.fn() };

  return { issues, projects, logger };
}

describe('SyncSubIssueSprint', () => {
  it('adds the child to the project and copies the parent iteration', async () => {
    const dependencies = createDependencies();
    const automation = new SyncSubIssueSprint(dependencies.issues, dependencies.projects, dependencies.logger);

    await automation.run(input);

    expect(dependencies.projects.addIssueToProject).toHaveBeenCalledWith('PROJECT', 'ISSUE_child');
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith('PROJECT', 'CHILD_ITEM', 'FIELD', 'ITERATION');
  });

  it('does not write when the child already has the parent iteration', async () => {
    const dependencies = createDependencies({ childIterationId: 'ITERATION' });
    const automation = new SyncSubIssueSprint(dependencies.issues, dependencies.projects, dependencies.logger);

    await automation.run(input);

    expect(dependencies.projects.addIssueToProject).not.toHaveBeenCalled();
    expect(dependencies.projects.setIteration).not.toHaveBeenCalled();
  });

  it('skips unsupported events before accessing GitHub', async () => {
    const dependencies = createDependencies();
    const automation = new SyncSubIssueSprint(dependencies.issues, dependencies.projects, dependencies.logger);

    await automation.run({ ...input, action: 'edited' });

    expect(dependencies.issues.getIssue).not.toHaveBeenCalled();
    expect(dependencies.projects.getProjectMetadata).not.toHaveBeenCalled();
  });
});
