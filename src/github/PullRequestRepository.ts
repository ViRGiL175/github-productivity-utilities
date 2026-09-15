import type { Octokit } from '@octokit/rest';
import type { RepositoryCoordinates } from './IssueRepository.js';

const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

export interface PullRequestRecord {
  nodeId: string;
  number: number;
  updatedAt: string;
  authorLogin: string;
}

export interface PullRequestListGateway {
  listPullRequests(
    repository: RepositoryCoordinates,
    state: 'open' | 'closed',
    page: number,
    perPage: number,
  ): Promise<PullRequestRecord[]>;
}

export class PullRequestRepository implements PullRequestListGateway {
  constructor(private readonly octokit: Octokit) {}

  async listPullRequests(
    repository: RepositoryCoordinates,
    state: 'open' | 'closed',
    page: number,
    perPage: number,
  ): Promise<PullRequestRecord[]> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/pulls', {
      ...repository,
      state,
      sort: 'updated',
      direction: 'desc',
      page,
      per_page: perPage,
      headers: API_HEADERS,
    });

    return response.data.map((pullRequest) => ({
      nodeId: pullRequest.node_id,
      number: pullRequest.number,
      updatedAt: pullRequest.updated_at,
      authorLogin: pullRequest.user?.login ?? '',
    }));
  }
}
