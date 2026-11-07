import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function saveFixtureJournal(path: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export function cleanupAttempts() {
  const failures: Error[] = [];
  return {

    async attempt(step: string, action: () => Promise<void>): Promise<void> {
      try { await action(); } catch (error) {
        failures.push(new Error(step));
        console.error(JSON.stringify({ event: 'analytics_cleanup_failed', step,
          httpStatus: typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined }));
      }
    },
    finish(): void {
      if (failures.length) throw new AggregateError(failures, 'Some isolated sandbox cleanup steps failed');
    },
  };
}
