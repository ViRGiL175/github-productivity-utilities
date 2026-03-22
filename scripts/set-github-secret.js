#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function printHelp() {
  console.log('Usage: node scripts/set-github-secret.js --name <SECRET_NAME> (--repo <owner/repo> | --org <org> --all-repos) [options]');
  console.log('');
  console.log('Target options:');
  console.log('  --repo <owner/repo>      Set secret for a single repository');
  console.log('  --org <org>              Organization whose repositories should be updated');
  console.log('  --all-repos              Required together with --org to target all repositories in the org');
  console.log('');
  console.log('Secret value options (use one source; falls back to GITHUB_SECRET_VALUE or stdin):');
  console.log('  --value <text>           Inline secret value (least secure because it may appear in shell history)');
  console.log('  --value-env <VAR_NAME>   Read secret value from an environment variable');
  console.log('  --value-file <path>      Read secret value from a file');
  console.log('');
  console.log('Bulk mode options:');
  console.log('  --include-archived       Include archived repositories when using --org --all-repos');
  console.log('  --include-disabled       Include disabled repositories when using --org --all-repos');
  console.log('  --include-forks          Include fork repositories when using --org --all-repos');
  console.log('  --yes, -y                Skip confirmation prompt for bulk updates');
  console.log('');
  console.log('Other options:');
  console.log('  --dry-run                Show what would be updated without writing secrets');
  console.log('  --help, -h               Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/set-github-secret.js --name ORG_PROJECT_TOKEN --repo octo-org/demo --value-env ORG_PROJECT_TOKEN');
  console.log('  node scripts/set-github-secret.js --name ORG_PROJECT_TOKEN --org octo-org --all-repos --value-file ./.tmp/org-project-token.txt --yes');
  console.log('  Get-Content ./.tmp/token.txt | node scripts/set-github-secret.js --name ORG_PROJECT_TOKEN --repo octo-org/demo');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseEnvFile(content) {
  const entries = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    let value = rawValue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    value = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');

    entries[key] = value;
  }

  return entries;
}

function loadDotEnv() {
  const envPath = path.join(repoRoot, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const options = {
    secretName: '',
    repo: '',
    org: '',
    allRepos: false,
    includeArchived: false,
    includeDisabled: false,
    includeForks: false,
    yes: false,
    dryRun: false,
    value: undefined,
    valueEnv: '',
    valueFile: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--name': {
        const value = argv[index + 1];
        if (!value) {
          fail('Missing value for --name.');
        }

        options.secretName = value;
        index += 1;
        break;
      }
      case '--repo': {
        const value = argv[index + 1];
        if (!value) {
          fail('Missing value for --repo.');
        }

        options.repo = value;
        index += 1;
        break;
      }
      case '--org': {
        const value = argv[index + 1];
        if (!value) {
          fail('Missing value for --org.');
        }

        options.org = value;
        index += 1;
        break;
      }
      case '--all-repos':
        options.allRepos = true;
        break;
      case '--include-archived':
        options.includeArchived = true;
        break;
      case '--include-disabled':
        options.includeDisabled = true;
        break;
      case '--include-forks':
        options.includeForks = true;
        break;
      case '--yes':
      case '-y':
        options.yes = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--value': {
        const value = argv[index + 1];
        if (value === undefined) {
          fail('Missing value for --value.');
        }

        options.value = value;
        index += 1;
        break;
      }
      case '--value-env': {
        const value = argv[index + 1];
        if (!value) {
          fail('Missing value for --value-env.');
        }

        options.valueEnv = value;
        index += 1;
        break;
      }
      case '--value-file': {
        const value = argv[index + 1];
        if (!value) {
          fail('Missing value for --value-file.');
        }

        options.valueFile = value;
        index += 1;
        break;
      }
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

function validateOptions(options) {
  if (!options.secretName) {
    fail('Secret name is required. Use --name <SECRET_NAME>.');
  }

  if (options.repo && (options.org || options.allRepos)) {
    fail('Use either --repo <owner/repo> or --org <org> --all-repos, not both.');
  }

  if (!options.repo && !options.org) {
    fail('Target is required. Use --repo <owner/repo> or --org <org> --all-repos.');
  }

  if (options.org && !options.allRepos) {
    fail('When using --org, add --all-repos to confirm that all repositories in the org should be updated.');
  }

  if (!options.repo && options.allRepos && !options.org) {
    fail('--all-repos requires --org <org>.');
  }

  const valueSources = [
    options.value !== undefined,
    Boolean(options.valueEnv),
    Boolean(options.valueFile),
  ].filter(Boolean).length;

  if (valueSources > 1) {
    fail('Use only one explicit secret value source: --value, --value-env, or --value-file.');
  }
}

function resolveGhCommand() {
  const candidates = process.platform === 'win32'
    ? ['gh.exe', 'gh.cmd', 'gh.bat', 'gh']
    : ['gh'];

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });

    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return null;
}

function ensureGhAvailable(ghCommand) {
  if (!ghCommand) {
    fail('GitHub CLI (gh) is not installed or is not available in PATH.');
  }
}

function ensureGhAuth(ghCommand) {
  const result = spawnSync(ghCommand, ['auth', 'status'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });

  if (result.error || result.status !== 0) {
    fail('GitHub CLI is not authenticated. Run `gh auth login` or provide GH_TOKEN / GITHUB_TOKEN.');
  }
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function resolveSecretValue(options) {
  if (options.value !== undefined) {
    return options.value;
  }

  if (options.valueEnv) {
    const envValue = process.env[options.valueEnv];
    if (envValue === undefined) {
      fail(`Environment variable '${options.valueEnv}' is not set.`);
    }

    return envValue;
  }

  if (options.valueFile) {
    const absolutePath = path.resolve(process.cwd(), options.valueFile);
    if (!existsSync(absolutePath)) {
      fail(`Secret value file was not found: ${absolutePath}`);
    }

    return readFileSync(absolutePath, 'utf8');
  }

  if (process.env.GITHUB_SECRET_VALUE !== undefined) {
    return process.env.GITHUB_SECRET_VALUE;
  }

  if (!process.stdin.isTTY) {
    const stdinValue = await readStdin();
    if (stdinValue.length === 0) {
      fail('Secret value was not provided. stdin was empty.');
    }

    return stdinValue;
  }

  fail('Secret value was not provided. Use --value, --value-env, --value-file, GITHUB_SECRET_VALUE, or pipe the value through stdin.');
}

function ghApiJson(ghCommand, args) {
  const result = spawnSync(ghCommand, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    fail(`Failed to run gh ${args.join(' ')}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    fail(`gh ${args.join(' ')} failed with exit code ${result.status}.${stderr ? ` ${stderr}` : ''}`);
  }

  return JSON.parse(result.stdout);
}

function listOrgRepositories(ghCommand, org, options) {
  const pages = ghApiJson(ghCommand, ['api', '--method', 'GET', '--paginate', '--slurp', `/orgs/${org}/repos?per_page=100&type=all`]);
  const repos = pages.flat().filter((repo) => {
    if (!options.includeArchived && repo.archived) {
      return false;
    }

    if (!options.includeDisabled && repo.disabled) {
      return false;
    }

    if (!options.includeForks && repo.fork) {
      return false;
    }

    return true;
  });

  repos.sort((left, right) => left.full_name.localeCompare(right.full_name));
  return repos.map((repo) => repo.full_name);
}

function formatRepoPreview(repos, maxItems = 10) {
  if (repos.length <= maxItems) {
    return repos.join(', ');
  }

  const preview = repos.slice(0, maxItems).join(', ');
  return `${preview}, ... (+${repos.length - maxItems} more)`;
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function confirmBulkUpdate(secretName, org, repos, options) {
  if (options.yes || options.dryRun) {
    return;
  }

  if (!process.stdin.isTTY) {
    fail('Bulk update requires confirmation. Re-run with --yes in non-interactive mode.');
  }

  console.log(`About to update secret '${secretName}' in ${repos.length} repositories from org '${org}'.`);
  console.log(`Targets: ${formatRepoPreview(repos)}`);
  const answer = (await prompt("Type 'yes' to continue: ")).trim().toLowerCase();

  if (answer !== 'yes') {
    fail('Bulk update was cancelled.');
  }
}

function setSecretForRepository(ghCommand, secretName, repo, secretValue, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] Would set '${secretName}' for ${repo}`);
    return { ok: true };
  }

  const result = spawnSync(ghCommand, ['secret', 'set', secretName, '--repo', repo], {
    cwd: repoRoot,
    input: secretValue,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    return {
      ok: false,
      error: `Failed to start gh secret set for ${repo}: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    return {
      ok: false,
      error: stderr || `gh secret set failed for ${repo} with exit code ${result.status}`,
    };
  }

  const stdout = (result.stdout || '').trim();
  if (stdout) {
    console.log(stdout);
  }

  console.log(`Updated '${secretName}' for ${repo}`);
  return { ok: true };
}

async function main() {
  loadDotEnv();

  const options = parseArgs(process.argv.slice(2));
  validateOptions(options);

  const ghCommand = resolveGhCommand();
  ensureGhAvailable(ghCommand);
  ensureGhAuth(ghCommand);

  const secretValue = await resolveSecretValue(options);
  const repositories = options.repo
    ? [options.repo]
    : listOrgRepositories(ghCommand, options.org, options);

  if (repositories.length === 0) {
    fail('No repositories matched the selected filters.');
  }

  await confirmBulkUpdate(options.secretName, options.org, repositories, options);

  const failures = [];
  for (const repo of repositories) {
    const result = setSecretForRepository(ghCommand, options.secretName, repo, secretValue, options.dryRun);
    if (!result.ok) {
      failures.push({ repo, error: result.error });
      console.error(`Failed to update ${repo}: ${result.error}`);
    }
  }

  console.log('');
  console.log(`Done. ${repositories.length - failures.length}/${repositories.length} repository updates succeeded.`);

  if (failures.length > 0) {
    console.error('Failed repositories:');
    for (const failure of failures) {
      console.error(`- ${failure.repo}: ${failure.error}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
