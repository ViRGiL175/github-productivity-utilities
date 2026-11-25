import { execFileSync } from 'node:child_process';
import { parseCompactFieldUpdates } from '../src/automations/field-updates/FieldUpdates.ts';

const input = process.env.FIELD_UPDATES ?? '';
if (input.trim() && parseCompactFieldUpdates(input) === undefined) {
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { stdio: 'inherit' });
}
