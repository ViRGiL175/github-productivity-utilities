import { describe, expect, it, vi } from 'vitest';
import { detachInboxSubIssues, withFormerParentBlock } from '../src/automations/detach-inbox-sub-issues/DetachInboxSubIssues.js';
import type { IssueHierarchyGateway } from '../src/github/IssueRepository.js';
import type { ProjectStatusGateway } from '../src/github/ProjectV2Repository.js';
import type { Logger } from '../src/runtime/Logger.js';

const input = {
  projectOwner: 'org', projectNumber: 8, horizonFieldName: 'Horizon', inboxValue: '📥 Inbox',
  issueNodeId: 'CHILD', issueRepository: { owner: 'org', repo: 'backlog' }, issueNumber: 12,
  previousHorizon: 'Ideas', currentHorizon: '📥 Inbox', dryRun: false,
};

function dependencies() {
  const projects = {
    getStatusMetadata: vi.fn().mockResolvedValue({
      projectId: 'PROJECT', optionIdsByName: new Map([['📥 Inbox', 'INBOX']]),
    }),
    getContentProjectItem: vi.fn().mockResolvedValue({ id: 'ITEM', statusName: '📥 Inbox' }),
  } as unknown as ProjectStatusGateway;
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

describe('DetachInboxSubIssues', () => {
  it('saves a managed former-parent link before detaching a child moved from Ideas to Inbox', async () => {
    const { projects, issues, logger } = dependencies();
    await detachInboxSubIssues(input, projects, issues, logger);
    expect(issues.updateIssueBody).toHaveBeenCalledWith(input.issueRepository, 12, expect.stringContaining('https://github.com/org/backlog/issues/11'));
    expect(issues.removeSubIssue).toHaveBeenCalledWith(input.issueRepository, 11, 120);
    expect(vi.mocked(issues.updateIssueBody).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(issues.removeSubIssue).mock.invocationCallOrder[0]!);
  });

  it.each([
    ['', '📥 Inbox'],
    ['📥 Inbox', '📥 Inbox'],
    ['📥 Inbox', 'Ideas'],
  ])('preserves an Inbox hierarchy for transition %j → %j', async (previousHorizon, currentHorizon) => {
    const { projects, issues, logger } = dependencies();
    await detachInboxSubIssues({ ...input, previousHorizon, currentHorizon }, projects, issues, logger);
    expect(projects.getStatusMetadata).not.toHaveBeenCalled();
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('ignores a stale transition when the item is no longer in Inbox', async () => {
    const { projects, issues, logger } = dependencies();
    vi.mocked(projects.getContentProjectItem).mockResolvedValue({ id: 'ITEM', statusName: 'Ideas', statusOptionId: 'IDEAS' });
    await detachInboxSubIssues(input, projects, issues, logger);
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('makes no changes in dry-run mode', async () => {
    const { projects, issues, logger } = dependencies();
    await detachInboxSubIssues({ ...input, dryRun: true }, projects, issues, logger);
    expect(issues.updateIssueBody).not.toHaveBeenCalled();
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('leaves an issue without a parent unchanged', async () => {
    const { projects, issues, logger } = dependencies();
    vi.mocked(issues.getParentIssue).mockResolvedValue(null);
    await detachInboxSubIssues(input, projects, issues, logger);
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
