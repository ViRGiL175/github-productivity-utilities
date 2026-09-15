import { describe, expect, it, vi } from 'vitest';
import { ReopenIssueIfPrOpen } from '../src/automations/reopen-issue-if-pr-open/ReopenIssueIfPrOpen.js';
import type { IssueReopenGateway } from '../src/github/IssueRepository.js';
import type { Logger } from '../src/runtime/Logger.js';

const input = { repository: { owner: 'owner', repo: 'backlog' }, issueNumber: 42 };

function createDependencies(body = 'Closes owner/backlog#42') {
  const issues: IssueReopenGateway = {
    listCrossReferencedPullRequests: vi.fn().mockResolvedValue([
      {
        number: 7,
        state: 'OPEN',
        title: 'Finish feature',
        body,
        repositoryNameWithOwner: 'owner/service',
      },
    ]),
    reopenIssue: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
  };
  const logger: Logger = { info: vi.fn() };
  return { issues, logger };
}

describe('ReopenIssueIfPrOpen', () => {
  it('reopens and comments when an open PR closes the issue', async () => {
    const dependencies = createDependencies();
    await new ReopenIssueIfPrOpen(dependencies.issues, dependencies.logger).run(input);

    expect(dependencies.issues.reopenIssue).toHaveBeenCalledWith(input.repository, 42);
    expect(dependencies.issues.addIssueComment).toHaveBeenCalledWith(
      input.repository,
      42,
      expect.stringContaining('owner/service#7'),
    );
  });

  it('ignores cross-references without a closing keyword for the target issue', async () => {
    const dependencies = createDependencies('Related to owner/backlog#42');
    await new ReopenIssueIfPrOpen(dependencies.issues, dependencies.logger).run(input);

    expect(dependencies.issues.reopenIssue).not.toHaveBeenCalled();
    expect(dependencies.issues.addIssueComment).not.toHaveBeenCalled();
  });

  it('rejects an invalid issue number before accessing GitHub', async () => {
    const dependencies = createDependencies();
    await expect(
      new ReopenIssueIfPrOpen(dependencies.issues, dependencies.logger).run({ ...input, issueNumber: 0 }),
    ).rejects.toThrow('valid issue_number');
    expect(dependencies.issues.listCrossReferencedPullRequests).not.toHaveBeenCalled();
  });
});
