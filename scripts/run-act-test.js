#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const workflowEntries = [
  {
    name: 'test-copilot-generate-text.yml',
    path: '.github/workflows/test-copilot-generate-text.yml',
    secrets: ['USER_COPILOT_FGPAT'],
  },
  {
    name: 'test-ensure-next-iteration-reminder.yml',
    path: '.github/workflows/test-ensure-next-iteration-reminder.yml',
    secrets: ['ORG_PROJECT_TOKEN', 'ORG_AUTOMATION_APP_ID', 'ORG_AUTOMATION_APP_PRIVATE_KEY'],
  },
  {
    name: 'test-link-pr-to-project.yml',
    path: '.github/workflows/test-link-pr-to-project.yml',
    secrets: ['ORG_PROJECT_TOKEN', 'ORG_AUTOMATION_APP_ID', 'ORG_AUTOMATION_APP_PRIVATE_KEY'],
  },
  {
    name: 'test-reopen-issue-if-pr-open.yml',
    path: '.github/workflows/test-reopen-issue-if-pr-open.yml',
    secrets: ['ORG_PROJECT_TOKEN', 'ORG_AUTOMATION_APP_ID', 'ORG_AUTOMATION_APP_PRIVATE_KEY'],
  },
  {
    name: 'test-safe-dependabot-pr-link.yml',
    path: '.github/workflows/test-safe-dependabot-pr-link.yml',
    secrets: ['ORG_PROJECT_TOKEN', 'ORG_AUTOMATION_APP_ID', 'ORG_AUTOMATION_APP_PRIVATE_KEY'],
  },
  {
    name: 'test-sync-sub-issue-sprint.yml',
    path: '.github/workflows/test-sync-sub-issue-sprint.yml',
    secrets: ['ORG_PROJECT_TOKEN', 'ORG_AUTOMATION_APP_ID', 'ORG_AUTOMATION_APP_PRIVATE_KEY'],
  },
  {
    name: 'test-collect-linked-context.yml',
    path: '.github/workflows/test-collect-linked-context.yml',
    secrets: ['ORG_PROJECT_TOKEN', 'ORG_AUTOMATION_APP_ID', 'ORG_AUTOMATION_APP_PRIVATE_KEY'],
  },
];

// Placeholder text, required auth modes, and error messages per secret.
const secretMeta = {
  USER_COPILOT_FGPAT: {
    placeholder: 'replace-with-your-copilot-fine-grained-pat',
    modes: ['pat', 'app'],
    failMessage: 'Update .secrets with a real USER_COPILOT_FGPAT (FGPAT with Copilot Requests permission) before running the Copilot integration test.',
    warnMessage: null,
  },
  ORG_PROJECT_TOKEN: {
    placeholder: 'replace-with-your-project-token',
    modes: ['pat'],
    failMessage: 'Update .secrets with a real ORG_PROJECT_TOKEN before running act in pat mode. You can start from .secrets.example.',
    warnMessage: 'Using placeholder ORG_PROJECT_TOKEN because dry run was requested.',
  },
  ORG_AUTOMATION_APP_ID: {
    placeholder: 'replace-with-your-github-app-id',
    modes: ['app'],
    failMessage: 'Update .secrets with real ORG_AUTOMATION_APP_ID and ORG_AUTOMATION_APP_PRIVATE_KEY before running act in app mode. You can start from .secrets.example.',
    warnMessage: 'Using placeholder GitHub App credentials because dry run was requested.',
  },
  ORG_AUTOMATION_APP_PRIVATE_KEY: {
    placeholder: 'replace-with-your-github-app-private-key',
    modes: ['app'],
    failMessage: 'Update .secrets with real ORG_AUTOMATION_APP_ID and ORG_AUTOMATION_APP_PRIVATE_KEY before running act in app mode. You can start from .secrets.example.',
    warnMessage: null,
  },
};

const workflowMap = new Map(workflowEntries.map((e) => [e.name, e]));

function printHelp() {
  console.log('Usage: node scripts/run-act-test.js [--files <workflow-file> [...workflow-file]] [--auth-mode <pat|app>] [--dry-run] [--list]');
  console.log('');
  console.log('Options:');
  console.log('  --files, -f <files...> Run one or more test workflows by file name; defaults to all');
  console.log('  --all                  Run all test workflows (default when --files is omitted)');
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

function maybeValidateSecrets(dryRun, authMode, selectedWorkflows) {
  const content = readSecretsFile();
  const shownMessages = new Set();

  const neededSecrets = new Set(
    selectedWorkflows.flatMap((name) => workflowMap.get(name).secrets),
  );

  for (const secret of neededSecrets) {
    const meta = secretMeta[secret];
    if (!meta.modes.includes(authMode)) continue;
    if (!content.includes(meta.placeholder)) continue;

    if (dryRun) {
      if (meta.warnMessage && !shownMessages.has(meta.warnMessage)) {
        shownMessages.add(meta.warnMessage);
        console.warn(meta.warnMessage);
      }
    } else if (!shownMessages.has(meta.failMessage)) {
      shownMessages.add(meta.failMessage);
      fail(meta.failMessage);
    }
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
  for (const entry of workflowMap.values()) {
    console.log(`- ${entry.name}: ${entry.path}`);
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
  const selectedWorkflows = resolveWorkflowSelections(options.files);
  maybeValidateSecrets(options.dryRun, options.authMode, selectedWorkflows);
  for (const workflowFile of selectedWorkflows) {
    const entry = workflowMap.get(workflowFile);
    runActWorkflow(actCommand, entry.name, entry.path, options.dryRun, options.authMode);
  }
}

main();
