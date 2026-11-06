import { readFile } from 'node:fs/promises';
import type { PoolConfig } from 'pg';
import type { Target } from './model.ts';

export interface Configuration {

  target: Target;
  repositories: string[];
  appId: string;
  privateKeyFile: string;
  keyReadApproved: boolean;
  database: PoolConfig;
  syncIntervalMs: number;
  webhook: { secret: string; port: number; host: '127.0.0.1' | '0.0.0.0' } | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

export async function configuration(): Promise<Configuration> {
  const syncIntervalMs = Number(process.env.SYNC_INTERVAL_SECONDS ?? '3600') * 1000;
  if (!Number.isSafeInteger(syncIntervalMs) || syncIntervalMs <= 0) {
    throw new Error('SYNC_INTERVAL_SECONDS must be a positive number of seconds.');
  }
  const number = Number(required('PROJECT_NUMBER'));
  const owner = required('PROJECT_OWNER');
  if (!Number.isSafeInteger(number) || number < 1 || !/^[A-Za-z0-9-]+$/.test(owner)) {
    throw new Error('Invalid project identity.');
  }
  const repositories = required('GITHUB_REPOSITORIES').split(',').map(value => value.trim());
  if (repositories.some(value => !/^[A-Za-z0-9_.-]+$/.test(value))) {
    throw new Error('Repository selection must contain repository names belonging to the configured owner.');
  }
  const secretFile = process.env.GITHUB_WEBHOOK_SECRET_FILE?.trim();
  let webhook: Configuration['webhook'] = null;
  if (secretFile) {
    const secret = (await readFile(secretFile, 'utf8')).trim();
    const port = Number(process.env.GITHUB_WEBHOOK_PORT ?? '8787');
    const host = process.env.GITHUB_WEBHOOK_HOST?.trim() || '127.0.0.1';
    if (secret.length < 32 || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        (host !== '127.0.0.1' && host !== '0.0.0.0')) {
      throw new Error('Webhook requires a secret of at least 32 characters, a valid port, and host 127.0.0.1 or 0.0.0.0.');
    }
    webhook = { secret, port, host };
  }
  return {
    webhook,
    target: { owner, number }, repositories,
    appId: required('GITHUB_APP_ID'),
    privateKeyFile: required('GITHUB_APP_PRIVATE_KEY_FILE'),
    keyReadApproved: process.env.ALLOW_GITHUB_APP_KEY_READ === 'true',
    syncIntervalMs,
    database: {
      host: process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.PGPORT ?? '55432'),
      database: 'project_analytics', user: 'analytics_writer',
      password: (await readFile(required('PGPASSWORD_FILE'), 'utf8')).trim(),
      max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 65_000,
    },
  };
}

export async function appCredentials(config: Configuration): Promise<{ appId: string; privateKey: string }> {
  if (!config.keyReadApproved) throw new Error('GitHub App credential access has not been explicitly approved.');
  const privateKey = await readFile(config.privateKeyFile, 'utf8');
  if (!/^[0-9]+$/.test(config.appId) || !/^-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey)) {
    throw new Error('The approved App ID or PEM key format is invalid.');
  }
  return { appId: config.appId, privateKey };
}
