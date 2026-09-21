import type { RepositoryCoordinates } from './IssueRepository.ts';

export interface TextClosingIssueReference {
  repository: RepositoryCoordinates;
  number: number;
}

const CLOSING_REFERENCE_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https:\/\/github\.com\/([^/\s"'<>]+)\/([^/\s"'<>]+)\/issues\/(\d+)|([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)#(\d+)|#(\d+))\b/gi;

export function collectClosingIssueReferences(
  text: string,
  defaultRepository?: RepositoryCoordinates,
): TextClosingIssueReference[] {
  const references = new Map<string, TextClosingIssueReference>();
  for (const match of text.matchAll(CLOSING_REFERENCE_PATTERN)) {
    const owner = match[1] ?? match[4] ?? defaultRepository?.owner;
    const repo = match[2] ?? match[5] ?? defaultRepository?.repo;
    const number = match[3] ?? match[6] ?? match[7];
    if (!owner || !repo || !number) continue;
    const reference = { repository: { owner, repo }, number: Number(number) };
    references.set(`${owner}/${repo}#${number}`.toLowerCase(), reference);
  }
  return [...references.values()];
}

export function hasClosingIssueReference(
  text: string,
  targetRepository: RepositoryCoordinates,
  targetNumber: number,
  defaultRepository?: RepositoryCoordinates,
): boolean {
  return collectClosingIssueReferences(text, defaultRepository).some((reference) =>
    reference.number === targetNumber
    && reference.repository.owner.toLowerCase() === targetRepository.owner.toLowerCase()
    && reference.repository.repo.toLowerCase() === targetRepository.repo.toLowerCase());
}
