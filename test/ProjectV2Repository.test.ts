import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { ProjectV2Repository } from '../src/github/ProjectV2Repository.js';

describe('ProjectV2Repository', () => {
  it('finds an iteration field beyond the first 50 fields', async () => {
    const fields = Array.from({ length: 75 }, (_, index) => ({ id: `FIELD_${index}`, name: `Field ${index}` }));
    fields[74] = { id: 'SPRINT_FIELD', name: 'Sprint' };
    const graphql = vi.fn().mockResolvedValue({ organization: { projectV2: { id: 'PROJECT', fields: { nodes: fields } } } });
    const request = vi.fn().mockResolvedValue({ data: { type: 'Organization' } });
    const repository = new ProjectV2Repository({ graphql, request } as unknown as Octokit);

    await expect(repository.getProjectMetadata('owner', 10, 'Sprint')).resolves.toEqual({
      projectId: 'PROJECT',
      iterationFieldId: 'SPRINT_FIELD',
    });
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('fields(first: 100)'), { owner: 'owner', number: 10 });
  });

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
