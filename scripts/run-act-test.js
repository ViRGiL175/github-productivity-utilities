#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const workflowMap = new Map([
  ['ensure-next-iteration-reminder', '.github/workflows/test-ensure-next-iteration-reminder.yml'],
  ['link-pr-to-project', '.github/workflows/test-link-pr-to-project.yml'],
  ['reopen-issue-if-pr-open', '.github/workflows/test-reopen-issue-if-pr-open.yml'],
  ['sync-sub-issue-sprint', '.github/workflows/test-sync-sub-issue-sprint.yml'],
]);

function printHelp() {
  console.log('Usage: node scripts/run-act-test.js [--workflow <name>|--all] [--dry-run] [--list]');
  console.log('');
  console.log('Options:');
  console.log('  --workflow, -w <name>  Run one test workflow by key');
  console.log('  --all                  Run all test workflows');
  console.log('  --dry-run              Pass --dryrun to act');
  console.log('  --list                 Print available workflow keys');
  console.log('  --help, -h             Show this help');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    workflow: 'ensure-next-iteration-reminder',
    dryRun: false,
    list: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--workflow':
      case '-w': {
        const value = argv[index + 1];
        if (!value) {
          fail(`Missing value for ${arg}.`);
        }

        options.workflow = value;
        index += 1;
        break;
      }
      case '--all':
        options.workflow = 'all';
        break;
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

function maybeValidateSecrets(dryRun) {
  const secretFileContent = readSecretsFile();
  const hasPlaceholder = secretFileContent.includes('replace-with-your-project-token');

  if (!dryRun && hasPlaceholder) {
    fail('Update .secrets with a real ORG_PROJECT_TOKEN before running act. You can start from .secrets.example.');
  }

  if (dryRun && hasPlaceholder) {
    console.warn('Using placeholder ORG_PROJECT_TOKEN because dry run was requested.');
  }
}

function runActWorkflow(actCommand, workflowName, workflowPath, dryRun) {
  const absoluteWorkflowPath = path.join(repoRoot, workflowPath);
  if (!existsSync(absoluteWorkflowPath)) {
    fail(`Workflow file '${workflowPath}' was not found.`);
  }

  const actArgs = ['workflow_dispatch', '-W', workflowPath];
  if (dryRun) {
    actArgs.push('--dryrun');
  }

  console.log(`Running ${workflowName} via act...`);

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
  console.log('Available test workflows:');
  for (const [name, workflowPath] of workflowMap.entries()) {
    console.log(`- ${name}: ${workflowPath}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    printWorkflowList();
    return;
  }

  if (options.workflow !== 'all' && !workflowMap.has(options.workflow)) {
    fail(`Unknown workflow key '${options.workflow}'. Use --list to see supported values.`);
  }

  const actCommand = resolveActCommand();
  ensureActAvailable(actCommand);
  ensureRequiredFiles();
  maybeValidateSecrets(options.dryRun);

  if (options.workflow === 'all') {
    for (const [workflowName, workflowPath] of workflowMap.entries()) {
      runActWorkflow(actCommand, workflowName, workflowPath, options.dryRun);
    }

    return;
  }

  runActWorkflow(actCommand, options.workflow, workflowMap.get(options.workflow), options.dryRun);
}

main();