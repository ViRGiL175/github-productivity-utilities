import { describe, expect, it, vi } from 'vitest';
import {
  CollectLinkedContext,
  collectReferences,
} from '../src/automations/collect-linked-context/CollectLinkedContext.js';
import type { LinkedContextGateway } from '../src/github/LinkedContextRepository.js';
import type { Logger } from '../src/runtime/Logger.js';

const defaultRepository = { owner: 'caller', repo: 'repository' };

function createDependencies() {
  const github: LinkedContextGateway = {
    getIssue: vi.fn().mockResolvedValue({ title: 'Issue title', body: 'Issue body', isPullRequest: false }),
    getRelease: vi.fn().mockResolvedValue({ name: 'Release name', body: 'Release body' }),
    getCommit: vi.fn().mockResolvedValue({ message: 'Commit message' }),
  };
  const logger: Logger = { info: vi.fn(), warning: vi.fn() };
  return { github, logger };
}

describe('CollectLinkedContext', () => {
  it('recognizes supported references and deduplicates equivalent issue links', () => {
    const references = collectReferences(
      [
        'https://github.com/owner/repo/issues/12',
        'owner/repo#12',
        '#13',
        'https://github.com/owner/repo/releases/tag/v1.2.3',
        'https://github.com/owner/repo/commit/abcdef0123456789',
      ].join('\n'),
      defaultRepository,
    );

    expect(references).toEqual([
      { type: 'issue', owner: 'owner', repo: 'repo', number: 12 },
      { type: 'issue', owner: 'caller', repo: 'repository', number: 13 },
      { type: 'release', owner: 'owner', repo: 'repo', tag: 'v1.2.3' },
      { type: 'commit', owner: 'owner', repo: 'repo', sha: 'abcdef0123456789' },
    ]);
  });

  it('fetches and formats GitHub content', async () => {
    const dependencies = createDependencies();
    const value = await new CollectLinkedContext(dependencies.github, dependencies.logger).run({
      text: 'See owner/repo#12 and https://github.com/owner/repo/releases/tag/v1.2.3',
      defaultRepository,
    });

    expect(value).toContain('Issue owner/repo#12 («Issue title»):\nIssue body');
    expect(value).toContain('Релиз owner/repo@v1.2.3 («Release name»):\nRelease body');
  });

  it('skips inaccessible references and keeps successful ones', async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.github.getIssue).mockRejectedValue(new Error('Not found'));
    const value = await new CollectLinkedContext(dependencies.github, dependencies.logger).run({
      text: 'owner/repo#12 https://github.com/owner/repo/commit/abcdef0',
      defaultRepository,
    });

    expect(value).toContain('Коммит abcdef0');
    expect(dependencies.logger.warning).toHaveBeenCalledWith(expect.stringContaining('Not found'));
  });

  it('returns an empty output when no links are present', async () => {
    const dependencies = createDependencies();
    const value = await new CollectLinkedContext(dependencies.github, dependencies.logger).run({
      text: 'No linked material',
      defaultRepository,
    });

    expect(value).toBe('');
  });
});
