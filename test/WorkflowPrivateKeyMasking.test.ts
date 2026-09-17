import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDirectory = join(process.cwd(), '.github', 'workflows');

describe('GitHub App private key handling', () => {
  it('masks each normalized PEM line before passing the key to another step', () => {
    let normalizers = 0;

    for (const filename of readdirSync(workflowsDirectory).filter((name) => name.endsWith('.yml'))) {
      const workflow = readFileSync(join(workflowsDirectory, filename), 'utf8');
      const steps = workflow.split(/^\s*- name: /m);

      for (const step of steps.filter((part) => part.startsWith('Normalize GitHub App private key\n'))) {
        normalizers += 1;
        const mask = step.indexOf("printf '::add-mask::%s\\n' \"$line\"");
        const output = step.indexOf('>> "$GITHUB_OUTPUT"');
        expect(mask, `${filename}: missing per-line key masking`).toBeGreaterThanOrEqual(0);
        expect(output, `${filename}: missing normalized key output`).toBeGreaterThan(mask);
        expect(step).not.toContain("printf 'private_key<<EOF\\n%b\\nEOF\\n'");
      }
    }

    expect(normalizers).toBeGreaterThan(0);
  });
});
