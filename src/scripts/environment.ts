export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is empty.`);
  return value;
}

export function repositoryName(name: string): string {
  const value = required(name);
  return value.includes('/') ? parseRepository(value).repo : value;
}

export function parseRepository(value: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = value.split('/');
  if (!owner || !repo || rest.length) throw new Error(`Expected owner/repository, received: ${value}`);
  return { owner, repo };
}
import type { Logger } from '../runtime/Logger.ts';

export const logger: Logger = { info: (message) => console.log(message), warning: (message) => console.warn(message) };
