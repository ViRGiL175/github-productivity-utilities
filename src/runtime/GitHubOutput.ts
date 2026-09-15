import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function writeGitHubOutput(name: string, value: string): Promise<void> {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    throw new Error('Required environment variable GITHUB_OUTPUT is empty.');
  }

  const delimiter = `github_productivity_${randomUUID()}`;
  await appendFile(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
}
