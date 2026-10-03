import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { PullRequestRepository } from '../src/github/PullRequestRepository.js';

describe('PullRequestRepository review state', () => {
  const repository = { owner: 'owner', repo: 'project' };

  it('reads only currently requested people and teams', async () => {
    const request = vi.fn().mockResolvedValue({ data: {
      user: { login: 'author' },
      requested_reviewers: [
        { login: 'alice', type: 'User' },
        { login: 'copilot[bot]', type: 'Bot' },
        null,
      ],
      requested_teams: [{ slug: 'maintainers' }],
    } });
    const gateway = new PullRequestRepository({ request } as unknown as Octokit);

    await expect(gateway.getReviewState(repository, 7)).resolves.toEqual({
      author: 'author',
      requestedReviewers: [
        { login: 'alice', type: 'User' },
        { login: 'copilot[bot]', type: 'Bot' },
      ],
      requestedTeams: 1,
    });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}',
      expect.objectContaining({ owner: 'owner', repo: 'project', pull_number: 7 }));
  });

  it('returns no pending reviewers after approval, requested changes, or dismissal', async () => {
    const request = vi.fn().mockResolvedValue({ data: {
      user: { login: 'author' }, requested_reviewers: [], requested_teams: [],
    } });
    const gateway = new PullRequestRepository({ request } as unknown as Octokit);
    await expect(gateway.getReviewState(repository, 7)).resolves.toEqual({
      author: 'author', requestedReviewers: [], requestedTeams: 0,
    });
  });
});

describe('PullRequestRepository listing', () => {
  it('includes body and branch for Sprint reconciliation', async () => {
    const request = vi.fn().mockResolvedValue({ data: [{
      node_id: 'PR_NODE', number: 7, updated_at: '2026-09-23T00:00:00Z',
      user: { login: 'author' }, body: 'Closes owner/backlog#42', head: { ref: '42-change' },
    }] });
    const gateway = new PullRequestRepository({ request } as unknown as Octokit);

    await expect(gateway.listPullRequests({ owner: 'owner', repo: 'service' }, 'open', 1, 100)).resolves.toEqual([{
      nodeId: 'PR_NODE', number: 7, updatedAt: '2026-09-23T00:00:00Z', authorLogin: 'author',
      body: 'Closes owner/backlog#42', headRef: '42-change',
    }]);
  });
});

describe('PullRequestRepository closing issues', () => {
  const repository = { owner: 'owner', repo: 'project' };

  it('reads every page of GitHub-recognized closing issue references', async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { closingIssuesReferences: {
        pageInfo: { hasNextPage: true, endCursor: 'NEXT' },
        nodes: [{ id: 'ISSUE_1', number: 11, repository: { nameWithOwner: 'owner/backlog' } }],
      } } } })
      .mockResolvedValueOnce({ repository: { pullRequest: { closingIssuesReferences: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: 'ISSUE_2', number: 12, repository: { nameWithOwner: 'owner/backlog' } }],
      } } } });
    const gateway = new PullRequestRepository({ graphql } as unknown as Octokit);

    await expect(gateway.listClosingIssues(repository, 7)).resolves.toEqual([
      { nodeId: 'ISSUE_1', number: 11, repositoryNameWithOwner: 'owner/backlog' },
      { nodeId: 'ISSUE_2', number: 12, repositoryNameWithOwner: 'owner/backlog' },
    ]);
    expect(graphql).toHaveBeenNthCalledWith(1, expect.stringContaining('closingIssuesReferences'),
      expect.objectContaining({ owner: 'owner', repo: 'project', number: 7, after: null }));
    expect(graphql).toHaveBeenNthCalledWith(2, expect.any(String),
      expect.objectContaining({ after: 'NEXT' }));
  });
});
