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
}

type GitHubIssueData = {
  id: number;
  node_id: string;
  number: number;
  repository_url: string;
  pull_request?: unknown;
};

export interface IssueReader {
  getIssue(repository: RepositoryCoordinates, issueNumber: number): Promise<IssueRecord>;
  getParentIssue(repository: RepositoryCoordinates, issueNumber: number): Promise<IssueRecord | null>;
}

export class IssueRepository implements IssueReader {
  constructor(private readonly octokit: Octokit) {}

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
  };
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }

  return typeof error.status === 'number' ? error.status : undefined;
}
