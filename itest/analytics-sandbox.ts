import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

export async function analyticsSandbox(): Promise<{ owner: string; number: number; backlog: string; repositories: string[] }> {
  const workflow = await readFile(new URL('../.github/workflows/test-link-pr-to-project.yml', import.meta.url), 'utf8');
  const settings = parse(workflow).env as Record<string, unknown>;
  function sandboxValue(key: string): string {
    const value = settings[key];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`Existing integration workflow has no sandbox setting for ${key}`);
    }
    return String(value);
  }
  const owner = sandboxValue('PROJECT_OWNER');
  const number = Number(sandboxValue('PROJECT_NUMBER'));
  const backlog = sandboxValue('BACKLOG_REPO_NAME');
  const client = sandboxValue('PULL_REQUEST_REPO_NAME');
  if (!Number.isSafeInteger(number) || number < 1 || [owner, backlog, client].some(value => !/^[A-Za-z0-9_.-]+$/.test(value))) {
    throw new Error('Invalid existing sandbox configuration');
  }
  return { owner, number, backlog, repositories: [backlog, client] };
}
