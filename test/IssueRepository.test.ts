import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { IssueRepository } from '../src/github/IssueRepository.js';

const repository = { owner: 'owner', repo: 'backlog' };
const marker = '<!-- managed -->';

function createRepository(responses: unknown[]) {
  const request = vi.fn();
  for (const response of responses) request.mockResolvedValueOnce(response);
  return {
    issues: new IssueRepository({ request } as unknown as Octokit),
    request,
  };
}

describe('IssueRepository managed comments', () => {
  it('creates a comment when the marker is absent', async () => {
    const { issues, request } = createRepository([{ data: [] }, { data: { id: 10 } }]);

    await expect(issues.upsertIssueCommentByMarker(repository, 42, marker, `Warning\n${marker}`))
      .resolves.toBe('created');

    expect(request).toHaveBeenLastCalledWith('POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      expect.objectContaining({ ...repository, issue_number: 42, body: `Warning\n${marker}` }));
  });

  it('updates the existing managed comment instead of creating a duplicate', async () => {
    const { issues, request } = createRepository([
      { data: [{ id: 15, body: `Old warning\n${marker}` }] },
      { data: { id: 15 } },
    ]);

    await expect(issues.upsertIssueCommentByMarker(repository, 42, marker, `New warning\n${marker}`))
      .resolves.toBe('updated');

    expect(request).toHaveBeenLastCalledWith('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
      expect.objectContaining({ ...repository, comment_id: 15, body: `New warning\n${marker}` }));
  });

  it('does not write when the managed comment is already current', async () => {
    const body = `Warning\n${marker}`;
    const { issues, request } = createRepository([{ data: [{ id: 15, body }] }]);

    await expect(issues.upsertIssueCommentByMarker(repository, 42, marker, body)).resolves.toBe('unchanged');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
