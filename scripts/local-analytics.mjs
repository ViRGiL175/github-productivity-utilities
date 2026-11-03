import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function prepareSecretPermissions(includeTls = false) {
  if (process.platform !== 'linux') return;
  const grants = [
    ['70', ['database-admin', 'database-writer', 'database-reader'].map(name => resolve('.local/secrets', name))],
    ['472', ['database-reader', 'grafana-admin', 'grafana-encryption'].map(name => resolve('.local/secrets', name))],
    ['472', ['GRAFANA_TLS_CERT_FILE', 'GRAFANA_TLS_KEY_FILE', 'GRAFANA_TLS_CA_FILE']
      .map(name => includeTls ? process.env[name] : undefined).filter(Boolean).map(path => resolve(path))],
  ];
  for (const [uid, paths] of grants) {
    if (!paths.length) continue;
    const result = spawnSync('setfacl', ['-m', 'u:' + uid + ':r', '--', ...paths], { cwd: root, stdio: 'pipe', windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error('Linux file-backed Docker secrets require setfacl and a filesystem with POSIX ACL support. No containers were started.');
    }
  }
}

function initialize() {
  mkdirSync('.local/secrets', { recursive: true, mode: 0o700 });
  for (const name of ['database-admin', 'database-writer', 'database-reader', 'grafana-admin', 'grafana-encryption']) {
    const path = resolve('.local/secrets', name);
    if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  prepareSecretPermissions();
  if (!existsSync('.local/analytics.env')) {
    copyFileSync('analytics/analytics.env.example', '.local/analytics.env');
    console.log('Created .local/analytics.env. Configure one project and approve App credential access before starting the collector.');
  }
}

const action = process.argv[2] ?? 'up';
const compose = ['compose', '--env-file', '.local/analytics.env', '-f', 'analytics/compose.yaml'];
if (action === 'init') {
  initialize();
} else if (action === 'permissions') {
  prepareSecretPermissions(true);
} else if (action === 'down') {
  run('docker', [...compose, 'stop']);
} else if (action === 'status') {
  run('docker', [...compose, 'ps']);
} else if (['up', 'infra', 'once'].includes(action)) {
  initialize();
  run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180']);
  if (action !== 'infra') {
    run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.analytics.json']);
    run(process.execPath, ['--env-file=.local/analytics.env', 'dist/analytics/main.js', ...(action === 'once' ? ['--once'] : [])]);
  }
} else {
  throw new Error('Use up, infra, once, down, status, init or permissions.');
}
