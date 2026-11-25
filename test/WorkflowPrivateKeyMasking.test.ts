import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowsDirectory = join(process.cwd(), '.github', 'workflows');

describe('GitHub App private key handling', () => {
  it('passes private keys directly from secrets to the token action', () => {
    let tokenSteps = 0;
    for (const filename of readdirSync(workflowsDirectory).filter(name => name.endsWith('.yml'))) {
      const workflow = readFileSync(join(workflowsDirectory, filename), 'utf8');
      const { jobs } = parse(workflow) as { jobs: Record<string, {
        steps?: Array<{ uses?: string; with?: Record<string, string> }>;
      }> };
      for (const job of Object.values(jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith('actions/create-github-app-token@')) continue;
          tokenSteps++;
          expect(step.with?.['private-key'], filename).toMatch(/secrets\.\w*private_key\b/i);
          expect(step.with?.['private-key'], filename).not.toContain('outputs.');
        }
      }
      expect(workflow, filename).not.toContain('private_key<<');
    }
    expect(tokenSteps).toBeGreaterThan(0);
  });
});
