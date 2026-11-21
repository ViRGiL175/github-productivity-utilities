import { setTimeout as delay } from 'node:timers/promises';
import type { IntegrationCore } from './runtime.ts';

export async function withRetry<T>(
  core: Pick<IntegrationCore, 'info'>, label: string, check: () => Promise<T>, attempts = 8, delayMs = 4000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await check();
    } catch (error) {
      const failure = error as { status?: number; response?: { status?: number }; message?: string } | null;
      const message = String(failure?.message ?? '');
      const retryable = error instanceof Error || (failure?.status ?? failure?.response?.status ?? 0) >= 500
        || /fetch failed|server error/i.test(message);
      if (attempt >= attempts || !retryable) throw error;
      core.info(`${label} attempt ${attempt}/${attempts} failed: ${message}. Retrying in ${delayMs}ms...`);
      await delay(delayMs);
    }
  }
}
