import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { IssueRepository } from '../src/github/IssueRepository.js';

describe('native issue fields', () => {
  it('reads the selected option from the issue rather than a project item', async () => {
    const request = vi.fn().mockResolvedValue({ data: [
      { issue_field_name: 'Priority', data_type: 'single_select', single_select_option: { name: 'High' } },
      { issue_field_name: 'Horizon', data_type: 'single_select', single_select_option: { name: '📥 Inbox' } },
    ] });
    const repository = new IssueRepository({ request } as unknown as Octokit);
    expect(await repository.getSingleSelectFieldValue({ owner: 'org', repo: 'backlog' }, 12, 'Horizon')).toBe('📥 Inbox');
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', expect.objectContaining({
      owner: 'org', repo: 'backlog', issue_number: 12,
      headers: expect.objectContaining({ 'X-GitHub-Api-Version': '2026-03-10' }),
    }));
  });

  it('treats an unset Horizon as empty', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] });
    const repository = new IssueRepository({ request } as unknown as Octokit);
    expect(await repository.getSingleSelectFieldValue({ owner: 'org', repo: 'backlog' }, 12, 'Horizon')).toBeNull();
  });

  it('rejects a Horizon with the wrong field type', async () => {
    const request = vi.fn().mockResolvedValue({ data: [{ issue_field_name: 'Horizon', data_type: 'text' }] });
    const repository = new IssueRepository({ request } as unknown as Octokit);
    await expect(repository.getSingleSelectFieldValue({ owner: 'org', repo: 'backlog' }, 12, 'Horizon')).rejects.toThrow('not single-select');
  });
});
