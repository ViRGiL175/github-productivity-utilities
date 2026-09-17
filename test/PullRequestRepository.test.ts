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
