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

  it('uses the user root for a personal project status field', async () => {
    const graphql = vi.fn().mockResolvedValue({ user: { projectV2: {
      id: 'PROJECT', title: 'Personal', fields: { nodes: [
        { __typename: 'ProjectV2SingleSelectField', id: 'STATUS', name: 'Status', options: [{ id: 'DONE', name: 'Done' }] },
      ] },
    } } });
    const request = vi.fn().mockResolvedValue({ data: { type: 'User' } });
    const repository = new ProjectV2Repository({ graphql, request } as unknown as Octokit);

    const metadata = await repository.getStatusMetadata('person', 3, 'Status');

    expect(metadata.optionIdsByName.get('Done')).toBe('DONE');
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('user(login: $owner)'), { owner: 'person', number: 3 });
    expect(graphql.mock.calls[0]?.[0]).not.toContain('organization(login: $owner)');
  });

  it('loads iteration configuration for an organization using the shared project query', async () => {
    const graphql = vi.fn().mockResolvedValue({ organization: { projectV2: {
      id: 'PROJECT', title: 'Org', fields: { nodes: [
        { __typename: 'ProjectV2IterationField', id: 'ITERATION', name: 'Sprint', configuration: {
          completedIterations: [], iterations: [{ id: 'NEXT', title: 'Next', startDate: '2026-09-21', duration: 7 }],
        } },
      ] },
    } } });
    const request = vi.fn().mockResolvedValue({ data: { type: 'Organization' } });
    const repository = new ProjectV2Repository({ graphql, request } as unknown as Octokit);

    const metadata = await repository.getIterationMetadata('org', 5, 'Sprint');

    expect(metadata.iterations.map(({ id }) => id)).toEqual(['NEXT']);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('organization(login: $owner)'), { owner: 'org', number: 5 });
  });

  it('reads iteration and status values through one shared issue/PR query', async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({ node: { projectItems: { nodes: [{
        id: 'ITEM', project: { id: 'PROJECT' }, fieldValueByName: { iterationId: 'SPRINT', title: 'Sprint 1' },
      }] } } })
      .mockResolvedValueOnce({ node: { projectItems: { nodes: [{
        id: 'ITEM', project: { id: 'PROJECT' }, fieldValueByName: { name: 'Done', optionId: 'DONE' },
      }] } } });
    const repository = new ProjectV2Repository({ graphql } as unknown as Octokit);

    await expect(repository.getIssueProjectItem('ISSUE', 'PROJECT', 'Sprint')).resolves.toMatchObject({ iterationId: 'SPRINT' });
    await expect(repository.getContentProjectItem('PR', 'PROJECT', 'Status')).resolves.toMatchObject({ statusName: 'Done' });
    expect(graphql.mock.calls[0]?.[0]).toBe(graphql.mock.calls[1]?.[0]);
    expect(graphql.mock.calls[0]?.[0]).toContain('fragment ProjectItems on ProjectV2ItemConnection');
  });

  it('handles a project scan page with null nodes', async () => {
    const graphql = vi.fn().mockResolvedValue({ node: { items: {
      pageInfo: { hasNextPage: false, endCursor: null }, nodes: null,
    } } });
    const repository = new ProjectV2Repository({ graphql } as unknown as Octokit);
    await expect(repository.listOpenIssuesWithField('PROJECT', 'Sprint')).resolves.toEqual([]);
  });
});
