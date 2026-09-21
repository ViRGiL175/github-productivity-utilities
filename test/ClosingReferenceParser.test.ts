import { describe, expect, it } from 'vitest';
import { collectClosingIssueReferences, hasClosingIssueReference } from '../src/github/ClosingReferenceParser.js';

describe('ClosingReferenceParser', () => {
  it('collects repository references, issue URLs, and same-repository shorthand', () => {
    const references = collectClosingIssueReferences([
      'Closes owner/backlog#10',
      'Fixed https://github.com/owner/backlog/issues/20',
      'Resolves #30',
      'Related to owner/backlog#40',
    ].join('\n'), { owner: 'owner', repo: 'service' });

    expect(references).toEqual([
      { repository: { owner: 'owner', repo: 'backlog' }, number: 10 },
      { repository: { owner: 'owner', repo: 'backlog' }, number: 20 },
      { repository: { owner: 'owner', repo: 'service' }, number: 30 },
    ]);
  });

  it('deduplicates equivalent references regardless of case or syntax', () => {
    const references = collectClosingIssueReferences([
      'Closes Owner/Backlog#42',
      'Fixes https://github.com/owner/backlog/issues/42',
    ].join('\n'));

    expect(references).toHaveLength(1);
    expect(references[0]?.number).toBe(42);
  });

  it('checks whether a body closes a specific issue', () => {
    expect(hasClosingIssueReference(
      'Resolved https://github.com/owner/backlog/issues/42',
      { owner: 'OWNER', repo: 'BACKLOG' },
      42,
    )).toBe(true);
    expect(hasClosingIssueReference(
      'Related to owner/backlog#42',
      { owner: 'owner', repo: 'backlog' },
      42,
    )).toBe(false);
  });
});
