import type {
  CommitContextReference,
  IssueContextReference,
  LinkedContextGateway,
  LinkedContextReference,
  ReleaseContextReference,
} from '../../github/LinkedContextRepository.ts';
import type { RepositoryCoordinates } from '../../github/IssueRepository.ts';
import type { Logger } from '../../runtime/Logger.ts';

const MAX_ITEMS = 5;
const MAX_BODY_CHARS = 800;

export interface CollectLinkedContextInput {
  text: string;
  defaultRepository: RepositoryCoordinates;
}

export async function collectLinkedContext(
input: CollectLinkedContextInput,
github: LinkedContextGateway,
logger: Logger,
): Promise<string> {
  const references = collectReferences(input.text, input.defaultRepository);
  logger.info(`Total unique references: ${references.length}`);
  const results: string[] = [];

  for (const reference of references.slice(0, MAX_ITEMS)) {
    const key = referenceKey(reference);
    try {
      logger.info(`Fetching: ${key}`);
      results.push(await fetchAndFormat(reference, github));
      logger.info(`OK: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warning(`Skipped ${key}: ${message}`);
    }
  }

  return results.length === 0 ? '' : `Связанные материалы:\n\n${results.join('\n\n---\n\n')}`;
}

async function fetchAndFormat(reference: LinkedContextReference, github: LinkedContextGateway): Promise<string> {
    if (reference.type === 'issue') {
      const data = await github.getIssue(reference);
      const kind = data.isPullRequest ? 'PR' : 'Issue';
      return `${kind} ${reference.owner}/${reference.repo}#${reference.number} («${data.title}»):\n${data.body.slice(0, MAX_BODY_CHARS)}`;
    }

    if (reference.type === 'release') {
      const data = await github.getRelease(reference);
      return `Релиз ${reference.owner}/${reference.repo}@${reference.tag} («${data.name ?? reference.tag}»):\n${data.body.slice(0, MAX_BODY_CHARS)}`;
    }

    const data = await github.getCommit(reference);
    return `Коммит ${reference.sha.slice(0, 7)} (${reference.owner}/${reference.repo}):\n${data.message.slice(0, MAX_BODY_CHARS)}`;
}

export function collectReferences(
  text: string,
  defaultRepository: RepositoryCoordinates,
): LinkedContextReference[] {
  const references = new Map<string, LinkedContextReference>();
  const add = (reference: LinkedContextReference, source: string): void => {
    const key = referenceKey(reference);
    if (!references.has(key)) {
      references.set(key, reference);
    }
  };

  for (const match of text.matchAll(/https:\/\/(?:redirect\.)?github\.com\/([^/\s"'<>]+)\/([^/\s"'<>]+)\/(?:pull|issues)\/(\d+)/g)) {
    add(issueReference(match[1], match[2], match[3]), 'github-pr-issue-url');
  }
  for (const match of text.matchAll(/(?:^|[\s,(:])#(\d+)/gm)) {
    add(issueReference(defaultRepository.owner, defaultRepository.repo, match[1]), 'short-ref');
  }
  for (const match of text.matchAll(/(?<![/\w])([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)#(\d+)/g)) {
    add(issueReference(match[1], match[2], match[3]), 'cross-repo-ref');
  }
  for (const match of text.matchAll(/https:\/\/github\.com\/([^/\s"'<>]+)\/([^/\s"'<>]+)\/releases\/tag\/([^\s"'<>)]+)/g)) {
    const reference: ReleaseContextReference = {
      type: 'release',
      owner: requiredMatch(match[1]),
      repo: requiredMatch(match[2]),
      tag: requiredMatch(match[3]),
    };
    add(reference, 'github-release-url');
  }
  for (const match of text.matchAll(/https:\/\/github\.com\/([^/\s"'<>]+)\/([^/\s"'<>]+)\/commit\/([0-9a-f]{7,40})\b/gi)) {
    const reference: CommitContextReference = {
      type: 'commit',
      owner: requiredMatch(match[1]),
      repo: requiredMatch(match[2]),
      sha: requiredMatch(match[3]),
    };
    add(reference, 'github-commit-url');
  }

  return [...references.values()];
}

function issueReference(owner: string | undefined, repo: string | undefined, number: string | undefined): IssueContextReference {
  return {
    type: 'issue',
    owner: requiredMatch(owner),
    repo: requiredMatch(repo),
    number: Number(requiredMatch(number)),
  };
}

function requiredMatch(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('Internal link parser error: expected capture group is missing.');
  }
  return value;
}

function referenceKey(reference: LinkedContextReference): string {
  if (reference.type === 'issue') {
    return `issue:${reference.owner}/${reference.repo}#${reference.number}`;
  }
  if (reference.type === 'release') {
    return `release:${reference.owner}/${reference.repo}@${reference.tag}`;
  }
  return `commit:${reference.owner}/${reference.repo}@${reference.sha}`;
}
