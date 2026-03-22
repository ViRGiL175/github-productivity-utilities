#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const workflowEntries = [
  ['test-ensure-next-iteration-reminder.yml', '.github/workflows/test-ensure-next-iteration-reminder.yml'],
  ['test-link-pr-to-project.yml', '.github/workflows/test-link-pr-to-project.yml'],
  ['test-reopen-issue-if-pr-open.yml', '.github/workflows/test-reopen-issue-if-pr-open.yml'],
  ['test-safe-dependabot-pr-link.yml', '.github/workflows/test-safe-dependabot-pr-link.yml'],
  ['test-sync-sub-issue-sprint.yml', '.github/workflows/test-sync-sub-issue-sprint.yml'],
];
const workflowMap = new Map(workflowEntries);
const legacyWorkflowAliases = new Map([
  ['ensure-next-iteration-reminder', 'test-ensure-next-iteration-reminder.yml'],
  ['link-pr-to-project', 'test-link-pr-to-project.yml'],
  ['reopen-issue-if-pr-open', 'test-reopen-issue-if-pr-open.yml'],
  ['safe-dependabot-pr-link', 'test-safe-dependabot-pr-link.yml'],
  ['sync-sub-issue-sprint', 'test-sync-sub-issue-sprint.yml'],
]);

function printHelp() {
  console.log('Usage: node scripts/run-act-test.js [--files <workflow-file> [...workflow-file]] [--auth-mode <pat|app>] [--dry-run] [--list]');
  console.log('');
  console.log('Options:');
  console.log('  --files, -f <files...> Run one or more test workflows by file name; defaults to all');
  console.log('  --workflow, -w <name>  Backward-compatible alias for a single legacy workflow key or file name');
  console.log('  --all                  Backward-compatible alias for running all test workflows');
  console.log('  --auth-mode <mode>     Select token source: pat or app');
  console.log('  --dry-run              Pass --dryrun to act');
  console.log('  --list                 Print available test workflow file names');
  console.log('  --help, -h             Show this help');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    files: [],
    authMode: 'pat',
    dryRun: false,
    list: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--files':
      case '-f': {
        const values = [];

        while (argv[index + 1] && !argv[index + 1].startsWith('-')) {
          values.push(argv[index + 1]);
          index += 1;
        }

        if (values.length === 0) {
          fail(`Missing value for ${arg}.`);
        }

        options.files.push(...values);
        break;
      }
      case '--workflow':
      case '-w': {
        const value = argv[index + 1];
        if (!value) {
          fail(`Missing value for ${arg}.`);
        }

        options.files.push(value);
        index += 1;
        break;
      }
      case '--all':
        break;
      case '--auth-mode': {
        const value = argv[index + 1];
        if (!value) {
          fail('Missing value for --auth-mode.');
        }

        if (!['pat', 'app'].includes(value)) {
          fail(`Unsupported auth mode '${value}'. Expected 'pat' or 'app'.`);
        }

        options.authMode = value;
        index += 1;
        break;
      }
      case '--dry-run':
      case '--dryrun':
        options.dryRun = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function normalizeWorkflowSelection(value) {
  if (workflowMap.has(value)) {
    return value;
  }

  if (legacyWorkflowAliases.has(value)) {
    return legacyWorkflowAliases.get(value);
  }

  const fileName = path.basename(value);
  if (workflowMap.has(fileName)) {
    return fileName;
  }

  return null;
}

function resolveWorkflowSelections(selectedFiles) {
  if (selectedFiles.length === 0) {
    return [...workflowMap.keys()];
  }

  const resolved = selectedFiles.map((value) => {
    const normalized = normalizeWorkflowSelection(value);
    if (!normalized) {
      fail(`Unknown workflow '${value}'. Use --list to see supported file names.`);
    }

    return normalized;
  });

  return [...new Set(resolved)];
}

function resolveActCommand() {
  const candidates = process.platform === 'win32'
    ? ['act.exe', 'act.cmd', 'act.bat', 'act']
    : ['act'];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });

    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

function ensureActAvailable(actCommand) {
  if (!actCommand) {
    fail('act is not installed or is not available in PATH.');
  }
}

function ensureRequiredFiles() {
  for (const relativePath of ['.secrets']) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) {
      const examplePath = `${relativePath}.example`;
      fail(`Required file '${relativePath}' was not found. Copy '${examplePath}' to '${relativePath}' and fill in the values.`);
    }
  }
}

function readSecretsFile() {
  return readFileSync(path.join(repoRoot, '.secrets'), 'utf8');
}

function maybeValidateSecrets(dryRun, authMode) {
  const secretFileContent = readSecretsFile();
  const patPlaceholder = secretFileContent.includes('replace-with-your-project-token');
  const appIdPlaceholder = secretFileContent.includes('replace-with-your-github-app-id');
  const appKeyPlaceholder = secretFileContent.includes('replace-with-your-github-app-private-key');

  if (authMode === 'pat' && !dryRun && patPlaceholder) {
    fail('Update .secrets with a real ORG_PROJECT_TOKEN before running act in pat mode. You can start from .secrets.example.');
  }

  if (authMode === 'app' && !dryRun && (appIdPlaceholder || appKeyPlaceholder)) {
    fail('Update .secrets with real ORG_AUTOMATION_APP_ID and ORG_AUTOMATION_APP_PRIVATE_KEY before running act in app mode. You can start from .secrets.example.');
  }

  if (dryRun && authMode === 'pat' && patPlaceholder) {
    console.warn('Using placeholder ORG_PROJECT_TOKEN because dry run was requested.');
  }

  if (dryRun && authMode === 'app' && (appIdPlaceholder || appKeyPlaceholder)) {
    console.warn('Using placeholder GitHub App credentials because dry run was requested.');
  }
}

function runActWorkflow(actCommand, workflowName, workflowPath, dryRun, authMode) {
  const absoluteWorkflowPath = path.join(repoRoot, workflowPath);
  if (!existsSync(absoluteWorkflowPath)) {
    fail(`Workflow file '${workflowPath}' was not found.`);
  }

  const actArgs = ['workflow_dispatch', '-W', workflowPath, '--input', `auth_mode=${authMode}`];
  if (dryRun) {
    actArgs.push('--dryrun');
  }

  console.log(`Running ${workflowName} via act with auth mode '${authMode}'...`);

  const result = spawnSync(actCommand, actArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`Failed to start act for workflow '${workflowName}': ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`act failed for workflow '${workflowName}' with exit code ${result.status}.`);
  }
}

function printWorkflowList() {
  console.log('Available test workflow files:');
  for (const [fileName, workflowPath] of workflowMap.entries()) {
    console.log(`- ${fileName}: ${workflowPath}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    printWorkflowList();
    return;
  }

  const actCommand = resolveActCommand();
  ensureActAvailable(actCommand);
  ensureRequiredFiles();
  maybeValidateSecrets(options.dryRun, options.authMode);

  const selectedWorkflows = resolveWorkflowSelections(options.files);
  for (const workflowFile of selectedWorkflows) {
    runActWorkflow(actCommand, workflowFile, workflowMap.get(workflowFile), options.dryRun, options.authMode);
  }
}

main();
