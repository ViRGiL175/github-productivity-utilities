import type { Octokit } from '@octokit/rest';

const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

export interface RepositoryCoordinates {
  owner: string;
  repo: string;
}

export interface IssueRecord {
  id: number;
  nodeId: string;
  number: number;
  repositoryUrl: string;
  isPullRequest: boolean;
  isOpen?: boolean;
}

type GitHubIssueData = {
  id: number;
  node_id: string;
  number: number;
  repository_url: string;
  pull_request?: unknown;
  state?: string;
};

export interface IssueReader {
  getIssue(repository: RepositoryCoordinates, issueNumber: number): Promise<IssueRecord>;
  getParentIssue(repository: RepositoryCoordinates, issueNumber: number): Promise<IssueRecord | null>;
}

export interface SubIssueReader {
  listSubIssues(repository: RepositoryCoordinates, parentNumber: number): Promise<Array<IssueRecord & { isOpen: boolean }>>;
}

export interface LinkedPullRequest {
  number: number;
  state: string;
  title: string;
  body: string;
  repositoryNameWithOwner: string;
}

export interface ClosingPullRequest {
  nodeId: string;
  number: number;
  repositoryNameWithOwner: string;
}

export interface IssueClosingPullRequestsGateway {
  listOpenClosingPullRequests(repository: RepositoryCoordinates, issueNumber: number): Promise<ClosingPullRequest[]>;
}

export interface IssueReopenGateway {
  listCrossReferencedPullRequests(
    repository: RepositoryCoordinates,
    issueNumber: number,
  ): Promise<LinkedPullRequest[]>;
  reopenIssue(repository: RepositoryCoordinates, issueNumber: number): Promise<void>;
  addIssueComment(repository: RepositoryCoordinates, issueNumber: number, body: string): Promise<void>;
}

export type ManagedCommentResult = 'created' | 'updated' | 'unchanged';

export interface IssueManagedCommentGateway {
  upsertIssueCommentByMarker(
    repository: RepositoryCoordinates,
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<ManagedCommentResult>;
}

const ISSUE_TIMELINE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 100) {
          nodes {
            ... on CrossReferencedEvent {
              source {
                __typename
                ... on PullRequest {
                  number
                  state
                  title
                  body
                  repository {
                    nameWithOwner
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const OPEN_CLOSING_PULL_REQUESTS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        closedByPullRequestsReferences(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id number repository { nameWithOwner } }
        }
      }
    }
  }
`;

interface IssueTimelineQueryResult {
  repository?: {
    issue?: {
      timelineItems?: {
        nodes: Array<{
          source?: {
            __typename?: string;
            number?: number;
            state?: string;
            title?: string;
            body?: string | null;
            repository?: { nameWithOwner?: string } | null;
          } | null;
        } | null>;
      } | null;
    } | null;
  } | null;
}

interface ClosingPullRequestsQueryResult {
  repository?: {
    issue?: {
      closedByPullRequestsReferences?: {
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
        nodes: Array<{ id: string; number: number; repository: { nameWithOwner: string } } | null>;
      } | null;
    } | null;
  } | null;
}

export class IssueRepository implements IssueReader, IssueReopenGateway, SubIssueReader, IssueClosingPullRequestsGateway, IssueManagedCommentGateway {
  private readonly octokit: Octokit;
  constructor(octokit: Octokit) { this.octokit = octokit; }

  async getIssue(repository: RepositoryCoordinates, issueNumber: number): Promise<IssueRecord> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      ...repository,
      issue_number: issueNumber,
      headers: API_HEADERS,
    });

    return mapIssue(response.data as GitHubIssueData);
  }

  async getParentIssue(repository: RepositoryCoordinates, issueNumber: number): Promise<IssueRecord | null> {
    try {
      const response = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/parent', {
        ...repository,
        issue_number: issueNumber,
        headers: API_HEADERS,
      });

      return mapIssue(response.data as GitHubIssueData);
    } catch (error) {
      if (getHttpStatus(error) === 404) {
        return null;
      }

      throw error;
    }
  }

  async listSubIssues(repository: RepositoryCoordinates, parentNumber: number): Promise<Array<IssueRecord & { isOpen: boolean }>> {
    const result: Array<IssueRecord & { isOpen: boolean }> = [];
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
        ...repository, issue_number: parentNumber, page, per_page: 100, headers: API_HEADERS,
      });
      for (const issue of response.data) {
        result.push({ ...mapIssue(issue as GitHubIssueData), isOpen: issue.state === 'open' });
      }
      if (response.data.length < 100) return result;
    }
  }

  async listCrossReferencedPullRequests(
    repository: RepositoryCoordinates,
    issueNumber: number,
  ): Promise<LinkedPullRequest[]> {
    const data = await this.octokit.graphql<IssueTimelineQueryResult>(ISSUE_TIMELINE_QUERY, {
      ...repository,
      number: issueNumber,
    });

    return (data.repository?.issue?.timelineItems?.nodes ?? []).flatMap((node) => {
      const source = node?.source;
      if (
        source?.__typename !== 'PullRequest' ||
        source.number === undefined ||
        source.state === undefined ||
        source.title === undefined ||
        source.repository?.nameWithOwner === undefined
      ) {
        return [];
      }

      return [{
        number: source.number,
        state: source.state,
        title: source.title,
        body: source.body ?? '',
        repositoryNameWithOwner: source.repository.nameWithOwner,
      }];
    });
  }

  async listOpenClosingPullRequests(repository: RepositoryCoordinates, issueNumber: number): Promise<ClosingPullRequest[]> {
    const result: ClosingPullRequest[] = [];
    let after: string | null = null;
    for (;;) {
      const data: ClosingPullRequestsQueryResult = await this.octokit.graphql<ClosingPullRequestsQueryResult>(
        OPEN_CLOSING_PULL_REQUESTS_QUERY, { ...repository, number: issueNumber, after },
      );
      const connection = data.repository?.issue?.closedByPullRequestsReferences;
      if (!connection) throw new Error(`Could not read closing PRs for ${repository.owner}/${repository.repo}#${issueNumber}.`);
      for (const item of connection.nodes) {
        if (item?.id && item.repository?.nameWithOwner) {
          result.push({ nodeId: item.id, number: item.number, repositoryNameWithOwner: item.repository.nameWithOwner });
        }
      }
      if (!connection.pageInfo.hasNextPage) return result;
      if (!connection.pageInfo.endCursor) throw new Error('Missing closing PR pagination cursor.');
      after = connection.pageInfo.endCursor;
    }
  }

  async reopenIssue(repository: RepositoryCoordinates, issueNumber: number): Promise<void> {
    await this.octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
      ...repository,
      issue_number: issueNumber,
      state: 'open',
      headers: API_HEADERS,
    });
  }

  async addIssueComment(repository: RepositoryCoordinates, issueNumber: number, body: string): Promise<void> {
    await this.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      ...repository,
      issue_number: issueNumber,
      body,
      headers: API_HEADERS,
    });
  }

  async upsertIssueCommentByMarker(
    repository: RepositoryCoordinates,
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<ManagedCommentResult> {
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        ...repository,
        issue_number: issueNumber,
        page,
        per_page: 100,
        headers: API_HEADERS,
      });
      const existing = response.data.find((comment) => comment.body?.includes(marker));
      if (existing) {
        if (existing.body === body) return 'unchanged';
        await this.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          ...repository,
          comment_id: existing.id,
          body,
          headers: API_HEADERS,
        });
        return 'updated';
      }
      if (response.data.length < 100) break;
    }

    await this.addIssueComment(repository, issueNumber, body);
    return 'created';
  }
}

export function parseRepositoryUrl(repositoryUrl: string): RepositoryCoordinates {
  const url = new URL(repositoryUrl);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'repos' && parts.length >= 3) {
    return { owner: parts[1]!, repo: parts[2]! };
  }

  if (parts.length >= 2) {
    return { owner: parts[0]!, repo: parts[1]! };
  }

  throw new Error(`Could not parse repository URL: ${repositoryUrl}`);
}

function mapIssue(issue: GitHubIssueData): IssueRecord {
  return {
    id: issue.id,
    nodeId: issue.node_id,
    number: issue.number,
    repositoryUrl: issue.repository_url,
    isPullRequest: issue.pull_request !== undefined,
    isOpen: issue.state === 'open',
  };
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }

  return typeof error.status === 'number' ? error.status : undefined;
}
