import { readFile } from 'node:fs/promises';

export async function analyticsSandbox(): Promise<{ owner: string; number: number; backlog: string; repositories: string[] }> {
  const workflow = await readFile(new URL('../.github/workflows/test-link-pr-to-project.yml', import.meta.url), 'utf8');
  function appValue(key: string): string {
    const line = workflow.split(/\r?\n/).find(value => value.startsWith(`  ${key}:`));
    const value = line?.match(/inputs\.auth_mode == 'app' && '([^']+)'/)?.[1];
    if (!value) throw new Error(`Existing integration workflow has no App sandbox setting for ${key}`);
    return value;
  }
  const owner = appValue('PROJECT_OWNER');
  const number = Number(appValue('PROJECT_NUMBER'));
  const backlog = appValue('BACKLOG_REPO_NAME');
  const client = appValue('PULL_REQUEST_REPO_NAME');
  if (!Number.isSafeInteger(number) || number < 1 || [owner, backlog, client].some(value => !/^[A-Za-z0-9_.-]+$/.test(value))) {
    throw new Error('Invalid existing App sandbox configuration');
  }
  return { owner, number, backlog, repositories: [backlog, client] };
}
