import type { Octokit } from '@octokit/rest';
import type { RepositoryCoordinates } from './IssueRepository.ts';

const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

export interface PullRequestRecord {
  nodeId: string;
  number: number;
  updatedAt: string;
  authorLogin: string;
  body?: string;
  headRef?: string;
}

export interface ClosingIssueReference {
  nodeId: string;
  number: number;
  repositoryNameWithOwner: string;
}

export interface PullRequestClosingIssuesGateway {
  listClosingIssues(
    repository: RepositoryCoordinates,
    pullRequestNumber: number,
  ): Promise<ClosingIssueReference[]>;
}

export interface PullRequestListGateway {
  listPullRequests(
    repository: RepositoryCoordinates,
    state: 'open' | 'closed',
    page: number,
    perPage: number,
  ): Promise<PullRequestRecord[]>;
}

export interface PullRequestMutationGateway {
  getPullRequestBody(repository: RepositoryCoordinates, pullRequestNumber: number): Promise<string>;
  updatePullRequestBody(repository: RepositoryCoordinates, pullRequestNumber: number, body: string): Promise<void>;
  getAssigneeLogins(repository: RepositoryCoordinates, issueNumber: number): Promise<string[]>;
  listAssignableLogins(repository: RepositoryCoordinates): Promise<Set<string>>;
  setAssignees(repository: RepositoryCoordinates, issueNumber: number, assignees: string[]): Promise<void>;
  getUserType(login: string): Promise<string | null>;
  getReviewState(repository: RepositoryCoordinates, pullRequestNumber: number): Promise<PullRequestReviewState>;
}

export interface PullRequestReviewState {
  author: string;
  requestedReviewers: Array<{ login: string; type: string }>;
  requestedTeams: number;
}

const CLOSING_ISSUES_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id number repository { nameWithOwner } }
        }
      }
    }
  }
`;

interface ClosingIssuesQueryResult {
  repository?: {
    pullRequest?: {
      closingIssuesReferences?: {
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
        nodes: Array<{ id: string; number: number; repository: { nameWithOwner: string } } | null>;
      } | null;
    } | null;
  } | null;
}

export class PullRequestRepository implements PullRequestListGateway, PullRequestMutationGateway, PullRequestClosingIssuesGateway {
  private readonly octokit: Octokit;
  constructor(octokit: Octokit) { this.octokit = octokit; }

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
      body: pullRequest.body ?? '',
      headRef: pullRequest.head.ref,
    }));
  }

  async getPullRequestBody(repository: RepositoryCoordinates, pullRequestNumber: number): Promise<string> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...repository,
      pull_number: pullRequestNumber,
      headers: API_HEADERS,
    });
    return response.data.body ?? '';
  }

  async listClosingIssues(
    repository: RepositoryCoordinates,
    pullRequestNumber: number,
  ): Promise<ClosingIssueReference[]> {
    const result: ClosingIssueReference[] = [];
    let after: string | null = null;
    for (;;) {
      const data: ClosingIssuesQueryResult = await this.octokit.graphql<ClosingIssuesQueryResult>(
        CLOSING_ISSUES_QUERY,
        { ...repository, number: pullRequestNumber, after },
      );
      const connection = data.repository?.pullRequest?.closingIssuesReferences;
      if (!connection) {
        throw new Error(`Could not read closing issues for ${repository.owner}/${repository.repo}#${pullRequestNumber}.`);
      }
      for (const issue of connection.nodes) {
        if (issue?.id && issue.repository?.nameWithOwner) {
          result.push({
            nodeId: issue.id,
            number: issue.number,
            repositoryNameWithOwner: issue.repository.nameWithOwner,
          });
        }
      }
      if (!connection.pageInfo.hasNextPage) return result;
      if (!connection.pageInfo.endCursor) throw new Error('Missing closing issue pagination cursor.');
      after = connection.pageInfo.endCursor;
    }
  }

  async updatePullRequestBody(
    repository: RepositoryCoordinates,
    pullRequestNumber: number,
    body: string,
  ): Promise<void> {
    await this.octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...repository,
      pull_number: pullRequestNumber,
      body,
      headers: API_HEADERS,
    });
  }

  async getAssigneeLogins(repository: RepositoryCoordinates, issueNumber: number): Promise<string[]> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      ...repository,
      issue_number: issueNumber,
      headers: API_HEADERS,
    });
    return (response.data.assignees ?? []).flatMap((assignee) => assignee?.login ? [assignee.login] : []);
  }

  async listAssignableLogins(repository: RepositoryCoordinates): Promise<Set<string>> {
    const logins = new Set<string>();
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.request('GET /repos/{owner}/{repo}/assignees', {
        ...repository,
        page,
        per_page: 100,
        headers: API_HEADERS,
      });
      for (const assignee of response.data) {
        if (assignee.login) logins.add(assignee.login);
      }
      if (response.data.length < 100) break;
    }
    return logins;
  }

  async setAssignees(repository: RepositoryCoordinates, issueNumber: number, assignees: string[]): Promise<void> {
    await this.octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
      ...repository,
      issue_number: issueNumber,
      assignees,
      headers: API_HEADERS,
    });
  }

  async getUserType(login: string): Promise<string | null> {
    try {
      const response = await this.octokit.request('GET /users/{username}', { username: login, headers: API_HEADERS });
      return response.data.type;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) return null;
      throw error;
    }
  }

  async getReviewState(repository: RepositoryCoordinates, pullRequestNumber: number): Promise<PullRequestReviewState> {
    const pull = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...repository, pull_number: pullRequestNumber, headers: API_HEADERS,
    });
    return {
      author: pull.data.user?.login ?? '',
      requestedReviewers: (pull.data.requested_reviewers ?? []).flatMap((user) =>
        user?.login ? [{ login: user.login, type: user.type }] : []),
      requestedTeams: pull.data.requested_teams?.length ?? 0,
    };
  }
}
