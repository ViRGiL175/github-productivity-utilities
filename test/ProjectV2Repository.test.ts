import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { ProjectV2Repository } from '../src/github/ProjectV2Repository.js';

describe('ProjectV2Repository', () => {
  it('treats an absent issue project item list as no membership', async () => {
    const octokit = { graphql: vi.fn().mockResolvedValue({ node: { projectItems: { nodes: null } } }) } as unknown as Octokit;
    const repository = new ProjectV2Repository(octokit);

    await expect(repository.getIssueProjectItem('ISSUE', 'PROJECT', 'Sprint')).resolves.toBeNull();
  });

  it('treats an absent PR project item list as no membership', async () => {
    const octokit = { graphql: vi.fn().mockResolvedValue({ node: { projectItems: { nodes: null } } }) } as unknown as Octokit;
    const repository = new ProjectV2Repository(octokit);

    await expect(repository.getContentProjectItem('PR', 'PROJECT', 'Status')).resolves.toBeNull();
  });
});
