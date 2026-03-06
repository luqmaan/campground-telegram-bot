const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const config = require('./config.ts');
const {
  appendCapped,
  ensureDir,
  formatDuration,
  makeId,
  nowIso,
  previewText,
  sanitizeText,
  slugify,
  stripAnsi,
  tailText,
} = require('./utils.ts');

type RunnerName = 'claude' | 'codex';

type UploadRecord = {
  id: string;
  kind: string;
  fileId: string;
  fileName: string;
  mimeType: string | null;
  localPath: string;
  size: number | null;
  addedAt: string;
};

type TaskResult = {
  id: string;
  runner: RunnerName;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  summary: string;
  finalOutput: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  branchName: string | null;
  commitSha: string | null;
  changedFiles: string[];
  keptWorktreePath: string | null;
  warnings: string[];
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
    throw new Error(`${command} ${args.join(' ')} failed: ${sanitizeText(result.stderr || result.stdout).slice(-500)}`);
  }
  return String(result.stdout || '').trim();
}

function tryRunCommand(command: string, args: string[], cwd = config.ROOT_DIR): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function repoSupportsIsolatedWorktree(): { allowed: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const branch = tryRunCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok || !branch.stdout || branch.stdout === 'HEAD') {
    warnings.push('Repo is not on a normal branch, so auto-branching is disabled.');
    return { allowed: false, warnings };
  }
  const status = tryRunCommand('git', ['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok || status.stdout) {
    warnings.push('Repo has local tracked changes, so auto-branching is disabled.');
    return { allowed: false, warnings };
  }
  return { allowed: true, warnings };
}

function prepareWorkspace(taskId: string, slug: string): Record<string, unknown> {
  ensureDir(config.WORKTREE_BASE_DIR);
  const branchCheck = repoSupportsIsolatedWorktree();
  if (!branchCheck.allowed) {
    return {
      cwd: config.ROOT_DIR,
      isolated: false,
      branchName: null,
      worktreePath: null,
      warnings: branchCheck.warnings,
    };
  }

  const datePrefix = new Date().toISOString().slice(0, 10);
  const branchName = `tg/${datePrefix}-${slug}-${taskId.slice(-6)}`;
  const worktreePath = path.join(config.WORKTREE_BASE_DIR, `${taskId}-${slug}`);

  try {
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    runCommand('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
    return {
      cwd: worktreePath,
      isolated: true,
      branchName,
      worktreePath,
      warnings: [],
    };
  } catch (error) {
    return {
      cwd: config.ROOT_DIR,
      isolated: false,
      branchName: null,
      worktreePath: null,
      warnings: [`Failed to create isolated worktree: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function cleanupIsolatedWorkspace(workspace: Record<string, unknown>, deleteBranch: boolean): string[] {
  const warnings: string[] = [];
  if (!workspace.isolated || !workspace.worktreePath) return warnings;

  const removeResult = tryRunCommand('git', ['worktree', 'remove', '--force', String(workspace.worktreePath)]);
  if (!removeResult.ok) {
    warnings.push(`Failed to remove worktree ${workspace.worktreePath}: ${sanitizeText(removeResult.stderr || removeResult.stdout)}`);
  }

  if (deleteBranch && workspace.branchName) {
    const branchResult = tryRunCommand('git', ['branch', '-D', String(workspace.branchName)]);
    if (!branchResult.ok) {
      warnings.push(`Failed to delete empty branch ${workspace.branchName}: ${sanitizeText(branchResult.stderr || branchResult.stdout)}`);
    }
  }

  return warnings;
}

function listChangedFiles(cwd: string): string[] {
  const output = tryRunCommand('git', ['status', '--porcelain', '--untracked-files=all'], cwd);
  if (!output.ok || !output.stdout) return [];
  return output.stdout
    .split('\n')
    .map((line) => line.slice(3).split(' -> ').pop())
    .filter(Boolean);
}

function commitChanges(cwd: string, runner: RunnerName, slug: string): { commitSha: string | null; changedFiles: string[] } {
  runCommand('git', ['add', '-A'], cwd);
  const stagedFiles = tryRunCommand('git', ['diff', '--cached', '--name-only'], cwd);
  if (!stagedFiles.ok || !stagedFiles.stdout) {
    return { commitSha: null, changedFiles: [] };
  }
  const changedFiles = stagedFiles.stdout.split('\n').filter(Boolean);
  runCommand('git', ['commit', '-m', `Telegram ${runner} task: ${slug}`], cwd);
  const commitSha = runCommand('git', ['rev-parse', '--short', 'HEAD'], cwd);
  return { commitSha, changedFiles };
}

function buildSummary(status: string, stdout: string, stderr: string): string {
  const source = status === 'completed' ? stdout || stderr : stderr || stdout;
  return previewText(source, config.RUNNER_SUMMARY_CHARS) || `${status} with no output`;
}

function startRunnerTask(options: {
  runner: RunnerName;
  promptText: string;
  promptPreview: string;
  uploads: UploadRecord[];
  timeoutSeconds: number;
  buildCommand: (context: Record<string, unknown>) => Record<string, unknown>;
  onProgress?: (progress: Record<string, unknown>) => Promise<void> | void;
}): Record<string, unknown> {
  const taskId = makeId(options.runner);
  const startedAt = Date.now();
  const startedAtIso = nowIso();
  const slug = slugify(options.promptPreview || 'task');
  const workspace = prepareWorkspace(taskId, slug);
  const promptFile = path.join(config.PROMPT_DIR, `${taskId}-${options.runner}.txt`);
  ensureDir(config.PROMPT_DIR);
  fs.writeFileSync(promptFile, options.promptText);

  let commandSpec: Record<string, unknown>;
  try {
    commandSpec = options.buildCommand({
      cwd: workspace.cwd,
      uploads: options.uploads,
      promptFile,
      branchName: workspace.branchName,
      taskId,
      slug,
    });
  } catch (error) {
    const warnings = [...(Array.isArray(workspace.warnings) ? workspace.warnings : [])];
    warnings.push(`Failed to build ${options.runner} command: ${error instanceof Error ? error.message : String(error)}`);
    warnings.push(...cleanupIsolatedWorkspace(workspace, true));
    return {
      meta: {
        id: taskId,
        runner: options.runner,
        promptPreview: previewText(options.promptPreview, 160),
        startedAt: startedAtIso,
        pid: null,
        status: 'running',
        uploadCount: options.uploads.length,
        branchName: null,
        warnings,
      },
      cancel: () => {},
      getPid: () => null,
      promise: Promise.resolve({
        id: taskId,
        runner: options.runner,
        status: 'failed',
        summary: warnings[warnings.length - 1],
        finalOutput: null,
        startedAt: startedAtIso,
        finishedAt: nowIso(),
        durationMs: 0,
        stdoutTail: '',
        stderrTail: '',
        branchName: null,
        commitSha: null,
        changedFiles: [],
        keptWorktreePath: null,
        warnings,
      }),
    };
  }

  let child;
  try {
    child = spawn(config.AGENT_WRAPPER_PATH, [String(commandSpec.command), ...commandSpec.args.map(String)], {
      cwd: String(workspace.cwd),
      env: {
        ...process.env,
        ...(commandSpec.env || {}),
        AGENT_TIMEOUT_SECONDS: String(options.timeoutSeconds),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const warnings = [...(Array.isArray(workspace.warnings) ? workspace.warnings : [])];
    warnings.push(`Failed to start ${options.runner}: ${error instanceof Error ? error.message : String(error)}`);
    warnings.push(...cleanupIsolatedWorkspace(workspace, true));
    return {
      meta: {
        id: taskId,
        runner: options.runner,
        promptPreview: previewText(options.promptPreview, 160),
        startedAt: startedAtIso,
        pid: null,
        status: 'running',
        uploadCount: options.uploads.length,
        branchName: null,
        warnings,
      },
      cancel: () => {},
      getPid: () => null,
      promise: Promise.resolve({
        id: taskId,
        runner: options.runner,
        status: 'failed',
        summary: warnings[warnings.length - 1],
        finalOutput: null,
        startedAt: startedAtIso,
        finishedAt: nowIso(),
        durationMs: 0,
        stdoutTail: '',
        stderrTail: '',
        branchName: null,
        commitSha: null,
        changedFiles: [],
        keptWorktreePath: null,
        warnings,
      }),
    };
  }

  child.stdin.end(options.promptText);

  let cancelled = false;
  let stdout = '';
  let stderr = '';
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let lastProgressSignature = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendCapped(stdout, chunk.toString());
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendCapped(stderr, chunk.toString());
  });

  if (options.onProgress) {
    progressTimer = setInterval(() => {
      const progress = {
        runner: options.runner,
        taskId,
        elapsedMs: Date.now() - startedAt,
        pid: child.pid || null,
        stdoutTail: tailText(stripAnsi(stdout), 500),
        stderrTail: tailText(stripAnsi(stderr), 500),
      };
      const signature = `${progress.stdoutTail}|${progress.stderrTail}|${Math.floor(Number(progress.elapsedMs) / 1000)}`;
      if (signature === lastProgressSignature) return;
      lastProgressSignature = signature;
      void Promise.resolve(options.onProgress?.(progress)).catch(() => {});
    }, config.RUNNER_PROGRESS_INTERVAL_MS);
  }

  const promise: Promise<TaskResult> = new Promise((resolve) => {
    const finish = (status: TaskResult['status'], extraWarnings: string[] = []): TaskResult => {
      if (progressTimer) {
        clearInterval(progressTimer);
      }

      const stdoutClean = stripAnsi(stdout).trim();
      const stderrClean = stripAnsi(stderr).trim();
      const warnings = [...(Array.isArray(workspace.warnings) ? workspace.warnings : []), ...extraWarnings];
      let commitSha: string | null = null;
      let changedFiles: string[] = [];
      let keptWorktreePath: string | null = null;
      let resultBranchName: string | null = workspace.branchName ? String(workspace.branchName) : null;

      if (workspace.isolated) {
        const dirtyFiles = listChangedFiles(String(workspace.cwd));
        if (status === 'completed' && dirtyFiles.length > 0) {
          try {
            const commitResult = commitChanges(String(workspace.cwd), options.runner, slug);
            commitSha = commitResult.commitSha;
            changedFiles = commitResult.changedFiles;
            warnings.push(...cleanupIsolatedWorkspace(workspace, false));
          } catch (error) {
            changedFiles = dirtyFiles;
            keptWorktreePath = String(workspace.worktreePath);
            warnings.push(`Auto-commit failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else if (dirtyFiles.length > 0) {
          changedFiles = dirtyFiles;
          keptWorktreePath = String(workspace.worktreePath);
        } else {
          warnings.push(...cleanupIsolatedWorkspace(workspace, true));
          resultBranchName = null;
        }
      }

      const result: TaskResult = {
        id: taskId,
        runner: options.runner,
        status,
        summary: buildSummary(status, stdoutClean, stderrClean),
        finalOutput: stdoutClean ? tailText(stdoutClean, config.RUNNER_FINAL_MESSAGE_CHARS) : null,
        startedAt: startedAtIso,
        finishedAt: nowIso(),
        durationMs: Date.now() - startedAt,
        stdoutTail: tailText(stdoutClean, config.RUNNER_STDOUT_TAIL_CHARS),
        stderrTail: tailText(stderrClean, config.RUNNER_STDOUT_TAIL_CHARS),
        branchName: resultBranchName,
        commitSha,
        changedFiles,
        keptWorktreePath,
        warnings,
      };

      if (status === 'timeout' && !result.summary) {
        result.summary = `${options.runner} timed out after ${formatDuration(Date.now() - startedAt)}.`;
      }
      return result;
    };

    child.on('error', (error: Error) => {
      resolve(finish('failed', [`${options.runner} process error: ${error.message}`]));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (cancelled) {
        resolve(finish('cancelled'));
        return;
      }
      if (code === 124 || code === 137) {
        resolve(finish('timeout'));
        return;
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        resolve(finish('timeout'));
        return;
      }
      if (code === 0) {
        resolve(finish('completed'));
        return;
      }
      resolve(finish('failed', [`${options.runner} exited with code ${String(code)}`]));
    });
  });

  return {
    meta: {
      id: taskId,
      runner: options.runner,
      promptPreview: previewText(options.promptPreview, 160),
      startedAt: startedAtIso,
      pid: child.pid || null,
      status: 'running',
      uploadCount: options.uploads.length,
      branchName: workspace.branchName ? String(workspace.branchName) : null,
      warnings: Array.isArray(workspace.warnings) ? workspace.warnings : [],
    },
    cancel: () => {
      cancelled = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    },
    getPid: () => child.pid || null,
    promise,
  };
}

module.exports = {
  startRunnerTask,
};
