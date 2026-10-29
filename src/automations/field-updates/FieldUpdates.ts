import type { Octokit } from '@octokit/rest';
import { FieldController } from '../../github/FieldController.ts';
import type { FieldConfig } from '../../github/FieldController.ts';
import type { RepositoryCoordinates } from '../../github/IssueRepository.ts';

export type FieldUpdates = (itemId: string, repository: RepositoryCoordinates, number: number) => Promise<void>;

export async function createFieldUpdates(
  github: Octokit, yaml: string, projectOwner: string, projectNumber: number,
): Promise<FieldUpdates | undefined> {
  if (!yaml.trim()) return undefined;
  const { parse } = await import('yaml');
  const config: unknown = parse(yaml, { uniqueKeys: true, maxAliasCount: 0 });
  validateConfig(config);
  const controller = new FieldController(github);
  return async (itemId, repository, issueNumber) => {
    try {
      const report = await controller.apply(config, {
        repository, issueNumber, project: { owner: projectOwner, number: projectNumber, itemId },
      });
      github.log.info(`Field updates: applied ${report.applied.join(', ') || 'none'}; skipped ${report.skipped.join(', ') || 'none'}`);
    } catch (cause) {
      throw new Error(`Field updates failed; project item ${itemId} remains added: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  };
}

function validateConfig(config: unknown): asserts config is FieldConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Field updates must be a YAML mapping');
  for (const [scope, fields] of Object.entries(config)) {
    if (scope === 'force') {
      if (typeof fields !== 'boolean') throw new Error('Field updates force must be boolean');
      continue;
    }
    if (!['project', 'issue'].includes(scope)) throw new Error(`Unknown field updates section: ${scope}`);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error(`Field updates ${scope} must be a name/value mapping`);
    for (const [name, value] of Object.entries(fields)) {
      if (!name.trim() || !(typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isFinite(value))) {
        throw new Error(`Field updates ${scope}.${name}: expected a nonempty string or finite number`);
      }
    }
  }
}
