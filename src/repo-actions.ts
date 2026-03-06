const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const config = require('./config.ts');
const { formatSince, nowIso, readJson, sanitizeText, writeJson } = require('./utils.ts');

type TaskResult = {
  commitSha?: string | null;
  branchName?: string | null;
};

function runCommand(command: string, args: string[], cwd = config.ROOT_DIR): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${sanitizeText(result.stderr || result.stdout).slice(-600)}`);
  }
  return String(result.stdout || '').trim();
}

function tryCommand(command: string, args: string[], cwd = config.ROOT_DIR): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    status: result.status,
  };
}

function worktreeClean(): boolean {
  const result = tryCommand('git', ['status', '--porcelain', '--untracked-files=no']);
  return result.ok && !result.stdout;
}

function repoSummary(): Record<string, unknown> {
  const branch = tryCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'unknown';
  const head = tryCommand('git', ['rev-parse', '--short', 'HEAD']).stdout || 'unknown';
  const clean = worktreeClean();
  return {
    branch,
    head,
    clean,
    deployState: loadDeployState(),
  };
}

function loadDeployState(): Record<string, unknown> | null {
  return readJson(config.DEPLOY_STATE_FILE, null);
}

function saveDeployState(state: Record<string, unknown>): void {
  writeJson(config.DEPLOY_STATE_FILE, state);
}

function resolveApplyRef(arg: string, lastResult: TaskResult | null | undefined): string | null {
  const direct = sanitizeText(arg || '');
  if (direct) return direct;
  if (lastResult?.commitSha) return String(lastResult.commitSha);
  if (lastResult?.branchName) return String(lastResult.branchName);
  return null;
}

function ensureDefaultBranchReady(): void {
  const branch = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== config.DEFAULT_BRANCH) {
    throw new Error(`Current branch is ${branch}; expected ${config.DEFAULT_BRANCH} before /apply.`);
  }
  if (!worktreeClean()) {
    throw new Error('Repo has local tracked changes. Refusing to apply onto a dirty working tree.');
  }
  const fetch = tryCommand('git', ['fetch', 'origin', config.DEFAULT_BRANCH]);
  if (!fetch.ok) {
    throw new Error(`git fetch origin ${config.DEFAULT_BRANCH} failed: ${sanitizeText(fetch.stderr || fetch.stdout)}`);
  }
  const localHead = runCommand('git', ['rev-parse', 'HEAD']);
  const remoteHead = runCommand('git', ['rev-parse', `origin/${config.DEFAULT_BRANCH}`]);
  if (localHead !== remoteHead) {
    throw new Error(`Local ${config.DEFAULT_BRANCH} is not aligned with origin/${config.DEFAULT_BRANCH}. Sync it before /apply.`);
  }
}

function applyRef(arg: string, lastResult: TaskResult | null | undefined): Record<string, unknown> {
  ensureDefaultBranchReady();
  const ref = resolveApplyRef(arg, lastResult);
  if (!ref) {
    throw new Error('No ref provided and there is no last runner commit or branch to apply.');
  }

  const resolvedCommit = runCommand('git', ['rev-parse', '--verify', `${ref}^{commit}`]);
  const alreadyApplied = tryCommand('git', ['merge-base', '--is-ancestor', resolvedCommit, 'HEAD']);
  if (alreadyApplied.ok) {
    return {
      ok: true,
      noop: true,
      ref,
      sourceCommit: resolvedCommit,
      head: runCommand('git', ['rev-parse', '--short', 'HEAD']),
      message: `${ref} is already included in ${config.DEFAULT_BRANCH}.`,
    };
  }

  const commitListOutput = runCommand('git', ['rev-list', '--reverse', `HEAD..${resolvedCommit}`]);
  const commits = commitListOutput.split('\n').filter(Boolean);
  if (!commits.length) {
    throw new Error(`No unapplied commits found for ${ref}.`);
  }

  for (const commit of commits) {
    const result = tryCommand('git', ['cherry-pick', '--no-edit', commit]);
    if (!result.ok) {
      tryCommand('git', ['cherry-pick', '--abort']);
      throw new Error(`Cherry-pick failed for ${commit}: ${sanitizeText(result.stderr || result.stdout)}`);
    }
  }

  const newHead = runCommand('git', ['rev-parse', '--short', 'HEAD']);
  const push = tryCommand('git', ['push', 'origin', config.DEFAULT_BRANCH]);
  if (!push.ok) {
    throw new Error(`Applied locally as ${newHead}, but push failed: ${sanitizeText(push.stderr || push.stdout)}`);
  }

  return {
    ok: true,
    noop: false,
    ref,
    sourceCommit: resolvedCommit,
    appliedCommits: commits.length,
    head: newHead,
    message: `Applied ${ref} onto ${config.DEFAULT_BRANCH} as ${newHead} and pushed origin/${config.DEFAULT_BRANCH}.`,
  };
}

function scheduleDeploy(requestedBy: string, requestedRef: string | null = null): Record<string, unknown> {
  const headBefore = runCommand('git', ['rev-parse', '--short', 'HEAD']);
  const state = {
    status: 'scheduled',
    requestedAt: nowIso(),
    requestedBy,
    requestedRef,
    headBefore,
    finishedAt: null,
    error: null,
  };
  saveDeployState(state);

  const child = spawn(process.execPath, [path.join(config.ROOT_DIR, 'scripts', 'deploy.ts')], {
    cwd: config.ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CAMPGROUND_DEPLOY_REQUESTED_BY: requestedBy,
      CAMPGROUND_DEPLOY_REQUESTED_REF: requestedRef || '',
      CAMPGROUND_DEPLOY_DELAY_MS: process.env.CAMPGROUND_DEPLOY_DELAY_MS || '2500',
    },
  });
  child.unref();

  return {
    ok: true,
    headBefore,
    message: `Deploy scheduled from ${config.DEFAULT_BRANCH}@${headBefore}. The bot will restart shortly.`,
  };
}

function shouldDeployFiles(changedFiles: string[]): boolean {
  return changedFiles.some((filePath) => {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    return (
      normalized.startsWith('src/') ||
      normalized.startsWith('bin/') ||
      normalized === 'ecosystem.config.cjs' ||
      normalized === 'package.json'
    );
  });
}

function deployStatusMessage(): string {
  const state = loadDeployState();
  if (!state) return 'No deploy has been recorded yet.';
  const pieces = [`Deploy: ${state.status}`];
  if (state.requestedAt) pieces.push(`requested ${state.requestedAt}`);
  if (state.finishedAt) pieces.push(`finished ${state.finishedAt}`);
  if (state.headAfter) pieces.push(`head ${state.headAfter}`);
  if (state.error) pieces.push(`error ${state.error}`);
  return pieces.join(' | ');
}

module.exports = {
  applyRef,
  deployStatusMessage,
  loadDeployState,
  repoSummary,
  scheduleDeploy,
  shouldDeployFiles,
};
