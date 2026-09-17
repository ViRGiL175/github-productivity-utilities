import { describe, expect, it, vi } from 'vitest';
import { detachInboxSubIssues, withFormerParentBlock } from '../src/automations/detach-inbox-sub-issues/DetachInboxSubIssues.js';
import type { IssueHierarchyGateway } from '../src/github/IssueRepository.js';
import type { ProjectIssueScanGateway, ProjectStatusGateway } from '../src/github/ProjectV2Repository.js';
import type { Logger } from '../src/runtime/Logger.js';

const candidate = {
  nodeId: 'CHILD', number: 12, repositoryNameWithOwner: 'org/backlog',
  parentNodeId: 'PARENT', parentNumber: 11, parentRepositoryNameWithOwner: 'org/backlog',
  fieldValue: '📥 Inbox', iterationId: null, subIssueCount: 0,
};

function dependencies() {
  const projects = {
    getStatusMetadata: vi.fn().mockResolvedValue({
      projectId: 'PROJECT', optionIdsByName: new Map([['📥 Inbox', 'INBOX']]),
    }),
    listOpenIssuesWithField: vi.fn().mockResolvedValue([candidate]),
  } as unknown as ProjectIssueScanGateway & ProjectStatusGateway;
  const issues: IssueHierarchyGateway = {
    getIssue: vi.fn().mockResolvedValue({ id: 120, nodeId: 'CHILD', number: 12, isPullRequest: false, repositoryUrl: 'https://api.github.com/repos/org/backlog' }),
    getParentIssue: vi.fn().mockResolvedValue({ id: 110, nodeId: 'PARENT', number: 11, isPullRequest: false, repositoryUrl: 'https://api.github.com/repos/org/backlog' }),
    getIssueBody: vi.fn().mockResolvedValue('Manual text'),
    updateIssueBody: vi.fn().mockResolvedValue(undefined),
    removeSubIssue: vi.fn().mockResolvedValue(undefined),
  };
  const logger: Logger = { info: vi.fn(), warning: vi.fn() };
  return { projects, issues, logger };
}

const input = { projectOwner: 'org', projectNumber: 8, horizonFieldName: 'Horizon', inboxValue: '📥 Inbox', dryRun: false };

describe('DetachInboxSubIssues', () => {
  it('saves a managed former-parent link before removing the hierarchy link', async () => {
    const { projects, issues, logger } = dependencies();
    await detachInboxSubIssues(input, projects, issues, logger);
    expect(issues.updateIssueBody).toHaveBeenCalledWith({ owner: 'org', repo: 'backlog' }, 12, expect.stringContaining('https://github.com/org/backlog/issues/11'));
    expect(issues.removeSubIssue).toHaveBeenCalledWith({ owner: 'org', repo: 'backlog' }, 11, 120);
    expect(vi.mocked(issues.updateIssueBody).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(issues.removeSubIssue).mock.invocationCallOrder[0]!);
  });

  it('makes no changes in dry-run mode', async () => {
    const { projects, issues, logger } = dependencies();
    await detachInboxSubIssues({ ...input, dryRun: true }, projects, issues, logger);
    expect(issues.updateIssueBody).not.toHaveBeenCalled();
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('skips a candidate whose parent changed between scanning and editing', async () => {
    const { projects, issues, logger } = dependencies();
    vi.mocked(issues.getParentIssue).mockResolvedValue(null);
    await detachInboxSubIssues(input, projects, issues, logger);
    expect(issues.updateIssueBody).not.toHaveBeenCalled();
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('does not unlink if saving the link fails', async () => {
    const { projects, issues, logger } = dependencies();
    vi.mocked(issues.updateIssueBody).mockRejectedValue(new Error('Forbidden'));
    await expect(detachInboxSubIssues(input, projects, issues, logger)).rejects.toThrow('Forbidden');
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('preserves manual text and replaces only its own block', () => {
    const first = withFormerParentBlock('Manual text', 'https://github.com/org/repo/issues/1');
    const second = withFormerParentBlock(first, 'https://github.com/org/repo/issues/2');
    expect(second).toContain('Manual text');
    expect(second).not.toContain('/issues/1');
    expect(second.match(/former-parent:start/g)).toHaveLength(1);
    expect(second).toContain('/issues/2');
  });

  it('refuses to edit an incomplete managed block', () => {
    expect(() => withFormerParentBlock('Text\n<!-- github-productivity-utilities:former-parent:start -->', 'https://example.com')).toThrow('incomplete');
  });
});
