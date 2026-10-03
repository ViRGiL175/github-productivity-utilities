import type { Octokit } from '@octokit/rest';
import { collectLinkedContext } from '../automations/collect-linked-context/CollectLinkedContext.ts';
import { LinkedContextRepository } from '../github/LinkedContextRepository.ts';
import { logger, parseRepository, required } from './environment.ts';

export async function run(github: Octokit, core: { setOutput(name: string, value: string): void }): Promise<void> {
  const value = await collectLinkedContext({
    text: process.env.INPUT_TEXT ?? '',
    defaultRepository: parseRepository(required('CALLER_REPOSITORY')),
  }, new LinkedContextRepository(github), logger);
  core.setOutput('value', value);
}
