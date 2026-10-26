import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { appCredentials, configuration } from './configuration.ts';
import { PostgresSnapshotStore } from './PostgresSnapshotStore.ts';
import { ProjectSnapshotReader, SnapshotReadError } from './ProjectSnapshotReader.ts';

const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = await configuration();
  const migrateOnly = process.argv.includes('--migrate-only');
  if (!migrateOnly && !config.keyReadApproved) throw new Error('GitHub App credential access is pending explicit approval.');
  const once = process.argv.includes('--once');
  const pool = new pg.Pool(config.database);
  const store = new PostgresSnapshotStore(pool);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());

  try {
    do {
      let failed = false;
      const result = await store.withLock(async session => {
        await session.bind(config.target);
        if (migrateOnly) {
          console.log(JSON.stringify({ event: 'schema_ready' }));
          return { due: false };
        }
        const previous = await session.lastCompletedAt();
        if (!once && previous && Date.now() - previous.getTime() < DAY) return { due: false };
        const runId = await session.begin();
        let stage = 'app_key';
        try {
          const auth = createAppAuth(await appCredentials(config));
          const appToken = await auth({ type: 'app' });
          const app = new Octokit({ auth: appToken.token, request: { timeout: 30_000 } });
          stage = 'installation_lookup';
          const installation = await app.apps.getOrgInstallation({ org: config.target.owner });
          stage = 'read_only_installation_token';
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
          const reader = new ProjectSnapshotReader(github);
          stage = 'project_snapshot';
          const snapshot = await reader.read(config.target);
          stage = 'database_commit';
          const counts = await session.save(runId, snapshot);
          console.log(JSON.stringify({ event: 'sync_complete', observedAt: snapshot.observedAt.toISOString(), ...counts }));
          return { due: true, ...counts };
        } catch (error) {
          await session.fail(runId);
          const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
          console.error(JSON.stringify({
            event: 'sync_failed', stage, httpStatus: status,
            errorType: error instanceof Error ? error.name : 'UnknownError',
            ...(error instanceof SnapshotReadError ? { reason: error.message, details: error.details } : {}),
          }));
          failed = true;
          if (once) throw new Error('Collection failed. Existing data was preserved; inspect permissions and the source schema.');
          return { due: true, failed: true };
        }
      });
      if (result === null) console.log(JSON.stringify({ event: 'another_collector_holds_lock' }));
      if (once || migrateOnly) break;
      try {
        await delay(failed ? 60 * 60 * 1000 : 60_000, undefined, { signal: stop.signal });
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Collector failed.');
  process.exitCode = 1;
});
