import { describe, expect, it, vi } from 'vitest';
import { detachInboxSubIssues, withFormerParentBlock } from '../src/automations/detach-inbox-sub-issues/DetachInboxSubIssues.js';
import type { IssueHierarchyGateway } from '../src/github/IssueRepository.js';
import type { Logger } from '../src/runtime/Logger.js';

const input = {
  horizonFieldName: 'Horizon', inboxValue: '📥 Inbox',
  issueNodeId: 'CHILD', issueRepository: { owner: 'org', repo: 'backlog' }, issueNumber: 12,
  previousHorizon: 'Ideas', currentHorizon: '📥 Inbox', dryRun: false,
};

function dependencies() {
  const issues: IssueHierarchyGateway = {
    getSingleSelectFieldValue: vi.fn().mockImplementation(async (_repository, number) => number === 12 ? '📥 Inbox' : 'Ideas'),
    getIssue: vi.fn().mockResolvedValue({ id: 120, nodeId: 'CHILD', number: 12, isPullRequest: false, repositoryUrl: 'https://api.github.com/repos/org/backlog' }),
    getParentIssue: vi.fn().mockResolvedValue({ id: 110, nodeId: 'PARENT', number: 11, isPullRequest: false, repositoryUrl: 'https://api.github.com/repos/org/backlog' }),
    getIssueBody: vi.fn().mockResolvedValue('Manual text'),
    updateIssueBody: vi.fn().mockResolvedValue(undefined),
    removeSubIssue: vi.fn().mockResolvedValue(undefined),
  };
  const logger: Logger = { info: vi.fn(), warning: vi.fn() };
  return { issues, logger };
}

describe('DetachInboxSubIssues', () => {
  it('saves a managed former-parent link before detaching a child moved from Ideas to Inbox', async () => {
    const { issues, logger } = dependencies();
    await detachInboxSubIssues(input, issues, logger);
    expect(issues.updateIssueBody).toHaveBeenCalledWith(input.issueRepository, 12, expect.stringContaining('https://github.com/org/backlog/issues/11'));
    expect(issues.removeSubIssue).toHaveBeenCalledWith(input.issueRepository, 11, 120);
    expect(vi.mocked(issues.updateIssueBody).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(issues.removeSubIssue).mock.invocationCallOrder[0]!);
  });

  it.each([
    ['', '📥 Inbox'],
    ['📥 Inbox', '📥 Inbox'],
    ['📥 Inbox', 'Ideas'],
  ])('preserves an Inbox hierarchy for transition %j → %j', async (previousHorizon, currentHorizon) => {
    const { issues, logger } = dependencies();
    await detachInboxSubIssues({ ...input, previousHorizon, currentHorizon }, issues, logger);
    expect(issues.getSingleSelectFieldValue).not.toHaveBeenCalled();
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('ignores a stale transition when the item is no longer in Inbox', async () => {
    const { issues, logger } = dependencies();
    vi.mocked(issues.getSingleSelectFieldValue).mockResolvedValue('Ideas');
    await detachInboxSubIssues(input, issues, logger);
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('preserves a subtree when its parent was also moved into Inbox', async () => {
    const { issues, logger } = dependencies();
    vi.mocked(issues.getSingleSelectFieldValue).mockResolvedValue('📥 Inbox');
    await detachInboxSubIssues(input, issues, logger);
    expect(issues.updateIssueBody).not.toHaveBeenCalled();
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('makes no changes in dry-run mode', async () => {
    const { issues, logger } = dependencies();
    await detachInboxSubIssues({ ...input, dryRun: true }, issues, logger);
    expect(issues.updateIssueBody).not.toHaveBeenCalled();
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('leaves an issue without a parent unchanged', async () => {
    const { issues, logger } = dependencies();
    vi.mocked(issues.getParentIssue).mockResolvedValue(null);
    await detachInboxSubIssues(input, issues, logger);
    expect(issues.removeSubIssue).not.toHaveBeenCalled();
  });

  it('does not unlink if saving the link fails', async () => {
    const { issues, logger } = dependencies();
    vi.mocked(issues.updateIssueBody).mockRejectedValue(new Error('Forbidden'));
    await expect(detachInboxSubIssues(input, issues, logger)).rejects.toThrow('Forbidden');
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
