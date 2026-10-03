import type { Octokit } from '@octokit/rest';

const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

export interface IssueContextReference {
  type: 'issue';
  owner: string;
  repo: string;
  number: number;
}

export interface ReleaseContextReference {
  type: 'release';
  owner: string;
  repo: string;
  tag: string;
}

export interface CommitContextReference {
  type: 'commit';
  owner: string;
  repo: string;
  sha: string;
}

export type LinkedContextReference = IssueContextReference | ReleaseContextReference | CommitContextReference;

export interface IssueContext {
  title: string;
  body: string;
  isPullRequest: boolean;
}

export interface ReleaseContext {
  name: string | null;
  body: string;
}

export interface CommitContext {
  message: string;
}

export interface LinkedContextGateway {
  getIssue(reference: IssueContextReference): Promise<IssueContext>;
  getRelease(reference: ReleaseContextReference): Promise<ReleaseContext>;
  getCommit(reference: CommitContextReference): Promise<CommitContext>;
}

export class LinkedContextRepository implements LinkedContextGateway {
  private readonly octokit: Octokit;
  constructor(octokit: Octokit) { this.octokit = octokit; }

  async getIssue(reference: IssueContextReference): Promise<IssueContext> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner: reference.owner,
      repo: reference.repo,
      issue_number: reference.number,
      headers: API_HEADERS,
    });

    return {
      title: response.data.title,
      body: response.data.body ?? '',
      isPullRequest: response.data.pull_request !== undefined,
    };
  }

  async getRelease(reference: ReleaseContextReference): Promise<ReleaseContext> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/releases/tags/{tag}', {
      owner: reference.owner,
      repo: reference.repo,
      tag: reference.tag,
      headers: API_HEADERS,
    });

    return { name: response.data.name, body: response.data.body ?? '' };
  }

  async getCommit(reference: CommitContextReference): Promise<CommitContext> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
      owner: reference.owner,
      repo: reference.repo,
      ref: reference.sha,
      headers: API_HEADERS,
    });

    return { message: response.data.commit.message ?? '' };
  }
}
