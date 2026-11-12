import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import pg from 'pg';
import { once as eventOnce } from 'node:events';
import { PostgresEventStore } from './PostgresEventStore.ts';
import { webhookServer } from './webhooks.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { appCredentials, configuration } from './configuration.ts';
import { PostgresSnapshotStore } from './PostgresSnapshotStore.ts';
import { ProjectSnapshotReader, SnapshotReadError } from './ProjectSnapshotReader.ts';
import { EventEnrichmentReader } from './EventEnrichmentReader.ts';

function apiRetryDelay(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const failure = error as { status?: number; headers?: Record<string, string>; response?: { headers?: Record<string, string> }; errors?: Array<{ type?: string }> };
  const headers = failure.headers ?? failure.response?.headers ?? {};
  if (![401, 403, 429].includes(failure.status ?? 0) && headers['x-ratelimit-remaining'] !== '0' &&
      !failure.errors?.some(item => item.type === 'RATE_LIMITED')) return null;
  const retryAfter = Number(headers['retry-after']) * 1000;
  const reset = headers['x-ratelimit-remaining'] === '0' ? Number(headers['x-ratelimit-reset']) * 1000 - Date.now() : 0;
  return Math.max(60_000, Number.isFinite(retryAfter) ? retryAfter : 0, Number.isFinite(reset) ? reset : 0);
}

async function main(): Promise<void> {
  const config = await configuration();
  const migrateOnly = process.argv.includes('--migrate-only');
  if (!migrateOnly && !config.keyReadApproved) throw new Error('GitHub App credential access is pending explicit approval.');
  const once = process.argv.includes('--once');
  const pool = new pg.Pool(config.database);
  pool.on('error', error => {
    console.error(JSON.stringify({ event: 'database_idle_connection_failed', errorType: error.name }));
  });
  const store = new PostgresSnapshotStore(pool);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());

  console.log(JSON.stringify({
    event: 'collector_started', syncIntervalSeconds: config.syncIntervalMs / 1000,
    mode: migrateOnly ? 'migrate' : once ? 'once' : 'continuous',
  }));
  const eventPool = config.webhook && !once && !migrateOnly ? new pg.Pool({
    ...config.database, max: 2, connectionTimeoutMillis: 1_000, statement_timeout: 2_000, query_timeout: 2_500,
  }) : null;
  eventPool?.on('error', error => {
    console.error(JSON.stringify({ event: 'webhook_database_connection_failed', errorType: error.name }));
  });
  let wake = new AbortController();
  let client: { github: Octokit; expiresAt: number } | null = null;
  let clientRetryAt = 0;
  let fullRetryAt = 0;
  const server = eventPool && config.webhook
    ? webhookServer(config.webhook.secret, new PostgresEventStore(eventPool, config.target, config.repositories, () => wake.abort())) : null;
  async function readClient(): Promise<Octokit> {
    if (client && client.expiresAt > Date.now() + 60_000) return client.github;
    const auth = createAppAuth(await appCredentials(config));
    const appToken = await auth({ type: 'app' });
    const app = new Octokit({ auth: appToken.token, request: { timeout: 30_000 } });
    const installation = await app.apps.getOrgInstallation({ org: config.target.owner });
    const token = await auth({
      type: 'installation', installationId: installation.data.id,
      repositoryNames: config.repositories,
      permissions: { organization_projects: 'read', metadata: 'read', issues: 'read', pull_requests: 'read' },
    });
    const readPermissions = new Set(['organization_projects', 'metadata', 'issues', 'pull_requests']);
    if (Object.entries(token.permissions).some(([name, access]) => !readPermissions.has(name) || access !== 'read') ||
        [...readPermissions].some(name => token.permissions[name as keyof typeof token.permissions] !== 'read') ||
        !token.repositoryNames || token.repositoryNames.length !== config.repositories.length ||
        token.repositoryNames.some(name => !config.repositories.includes(name))) {
      throw new Error('GitHub returned unexpected installation token access.');
    }
    console.log(JSON.stringify({ event: 'read_only_token_verified', permissions: token.permissions, repositories: token.repositoryNames.length }));
    const github = new Octokit({ auth: token.token, request: { timeout: 30_000 } });
    client = { github, expiresAt: Date.parse(token.expiresAt) };
    return github;
  }
  try {
    if (server && config.webhook) {
      server.listen(config.webhook.port, config.webhook.host);
      await eventOnce(server, 'listening');
      console.log(JSON.stringify({ event: 'webhook_listening', port: config.webhook.port }));
    }
    do {
      if (wake.signal.aborted) {
        wake = new AbortController();
        try { await delay(1_500, undefined, { signal: stop.signal }); } catch { break; }
      }
      let retryDelayMs = 60_000;
      let stage = 'database_connect';
      try {
        const result = await store.withLock(async session => {
          stage = 'database_identity';
          await session.bind(config.target);
          if (migrateOnly) {
            console.log(JSON.stringify({ event: 'schema_ready' }));
            return { due: false };
          }
          stage = 'database_schedule';
          const previous = await session.lastCompletedAt();
          const due = once || ((!previous || Date.now() - previous.getTime() >= config.syncIntervalMs) && Date.now() >= fullRetryAt);
          const pending = await session.pendingEvents();
          if ((!due && !pending) || (!once && Date.now() < clientRetryAt)) return { due: false };
          stage = 'read_only_installation_token';
          const github = await readClient();
          clientRetryAt = 0;
          if (pending) {
            stage = 'event_enrichment';
            try {
              const enrichment = await new EventEnrichmentReader(github, config.target.owner, config.repositories).read(pending);
              stage = 'database_enrichment';
              await session.enrichEvents(pending, enrichment);
              console.log(JSON.stringify({ event: 'events_enriched', deliveries: pending.deliveries.length,
                observations: enrichment.observations.length, parentEvents: enrichment.parentEvents.length,
                observedAt: enrichment.observedAt.toISOString() }));
            } catch (error) {
              await session.retryEvents(pending, apiRetryDelay(error) ?? 60_000);
              console.error(JSON.stringify({ event: 'event_enrichment_failed', stage,
                errorType: error instanceof Error ? error.name : 'UnknownError',
                ...(error instanceof SnapshotReadError ? { reason: error.message } : {}) }));
              if (stage.startsWith('database_')) throw error;
              if (apiRetryDelay(error) !== null) throw error;
            }
            retryDelayMs = 0;
          }
          if (!due) return { due: false };
          stage = 'database_begin';
          const runId = await session.begin();
          try {
            const reader = new ProjectSnapshotReader(github);
            stage = 'project_snapshot';
            const snapshot = await reader.read(config.target);
            stage = 'database_commit';
            const counts = await session.save(runId, snapshot);
            fullRetryAt = 0;
            console.log(JSON.stringify({ event: 'sync_complete', observedAt: snapshot.observedAt.toISOString(), ...counts }));
            return { due: true, ...counts };
          } catch (error) {
            fullRetryAt = Date.now() + (stage.startsWith('database_') ? 60_000 : 60 * 60 * 1000);
            try {
              await session.fail(runId);
            } catch (recordError) {
              console.error(JSON.stringify({ event: 'sync_failure_not_recorded',
                errorType: recordError instanceof Error ? recordError.name : 'UnknownError' }));
            }
            throw error;
          }
        });
        if (result === null) console.log(JSON.stringify({ event: 'another_collector_holds_lock' }));
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
        console.error(JSON.stringify({
          event: 'sync_failed', stage, httpStatus: status,
          errorType: error instanceof Error ? error.name : 'UnknownError',
          ...(error instanceof SnapshotReadError ? { reason: error.message, details: error.details } : {}),
        }));
        if (once || migrateOnly) throw new Error('Collection failed. Existing data was preserved; inspect permissions and the source schema.');
        if (stage === 'read_only_installation_token' || stage === 'event_enrichment') {
          clientRetryAt = Date.now() + (apiRetryDelay(error) ?? 60_000);
          client = null;
        }
        retryDelayMs = 60_000;
      }
      if (once || migrateOnly) break;
      try {
        await delay(retryDelayMs, undefined, { signal: AbortSignal.any([stop.signal, wake.signal]) });
      } catch (error) {
        if (!stop.signal.aborted && !wake.signal.aborted) throw error;
      }
    } while (!stop.signal.aborted);
  } finally {
    if (server?.listening) {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await closed;
    }
    await eventPool?.end();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Collector failed.');
  process.exitCode = 1;
});
