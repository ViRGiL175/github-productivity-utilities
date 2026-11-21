import assert from 'node:assert/strict';

export function analyticsSandbox() {
  const owner = process.env.PROJECT_OWNER;
  const number = Number(process.env.PROJECT_NUMBER);
  const repositories = (process.env.GITHUB_REPOSITORIES ?? '').split(',');
  assert.ok(owner === 'ViRGiL-GH-Productivity');
  assert.ok(Number.isSafeInteger(number) && number > 1, 'Expected an isolated copy of the sandbox project');
  assert.deepEqual(repositories, ['scrum-test-backlog', 'test-client']);
  return { owner, number, backlog: repositories[0]!, repositories };
}
