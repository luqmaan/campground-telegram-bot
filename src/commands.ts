const config = require('./config.ts');
const { formatDuration, formatSince, previewText, relativeDisplayPath, sanitizeText, tailText } = require('./utils.ts');
const { displayName } = require('./session-store.ts');

function parseCommand(rawText: string): Record<string, unknown> {
  const text = sanitizeText(rawText);
  if (!text) return { type: 'empty' };

  const slashMatch = text.match(/^\/([a-z_]+)(?:@[\w_]+)?(?:\s+(.*))?$/i);
  if (slashMatch) {
    const name = slashMatch[1].toLowerCase();
    const arg = sanitizeText(slashMatch[2] || '');
    if (name === 'start' || name === 'help') return { type: 'help' };
    if (name === 'status') return { type: 'status' };
    if (name === 'run_now' || name === 'runnow' || name === 'check') return { type: 'run-monitor' };
    if (name === 'pause_monitor' || name === 'pause') return { type: 'pause-monitor' };
    if (name === 'resume_monitor' || name === 'resume') return { type: 'resume-monitor' };
    if (name === 'restart_monitor' || name === 'restart') return { type: 'restart-monitor' };
    if (name === 'users') return { type: 'users' };
    if (name === 'forget' || name === 'clear' || name === 'reset') return { type: 'forget' };
    if (name === 'cancel') return { type: 'cancel' };
    if (name === 'apply') return { type: 'apply', ref: arg };
    if (name === 'deploy') return { type: 'deploy' };
    if (name === 'logs') return { type: 'logs', scope: arg || 'all' };
    if (name === 'claude') return { type: 'runner', runner: 'claude', prompt: arg };
    if (name === 'codex') return { type: 'runner', runner: 'codex', prompt: arg };
  }

  const lower = text.toLowerCase();
  if (/^(help|\?|actions?)$/.test(lower)) return { type: 'help' };
  if (/^(status|health|overview)$/.test(lower)) return { type: 'status' };
  if (/^(users|who|authorized)$/.test(lower)) return { type: 'users' };
  if (/^(run|run now|check|check now)$/.test(lower)) return { type: 'run-monitor' };
  if (/^(pause|pause monitor|stop monitor)$/.test(lower)) return { type: 'pause-monitor' };
  if (/^(resume|resume monitor|start monitor)$/.test(lower)) return { type: 'resume-monitor' };
  if (/^(restart|restart monitor)$/.test(lower)) return { type: 'restart-monitor' };
  if (/^logs?(?:\s+(monitor|runner|all))?$/.test(lower)) {
    const match = lower.match(/^logs?(?:\s+(monitor|runner|all))?$/);
    return { type: 'logs', scope: match?.[1] || 'all' };
  }
  if (/^(forget|clear|reset)$/.test(lower)) return { type: 'forget' };
  if (/^cancel(?:\s+(claude|codex))?$/.test(lower)) return { type: 'cancel' };
  if (/^apply(?:\s+.+)?$/.test(lower)) return { type: 'apply', ref: text.slice(5).trim() };
  if (/^deploy$/.test(lower)) return { type: 'deploy' };
  if (lower.startsWith('claude ')) return { type: 'runner', runner: 'claude', prompt: text.slice(7).trim() };
  if (lower.startsWith('codex ')) return { type: 'runner', runner: 'codex', prompt: text.slice(6).trim() };
  return { type: 'runner', runner: 'claude', prompt: text };
}

function helpMessage(): string {
  return [
    'Campground bot commands',
    '/status',
    '/run-now',
    '/pause-monitor',
    '/resume-monitor',
    '/restart-monitor',
    '/logs [monitor|runner]',
    '/users',
    '/forget',
    '/cancel',
    '/apply [commit-or-branch]',
    '/deploy',
    '/claude <task>',
    '/codex <task>',
    '',
    'Successful code changes are auto-applied to main.',
    'Runtime-affecting changes are auto-deployed after apply.',
    'Plain text defaults to Claude.',
    'Uploads with no text are queued for the next Claude or Codex task.',
  ].join('\n');
}

function usersMessage(users: Array<Record<string, unknown>>, maxAuthorizedUsers: number): string {
  const lines = [`Authorized users (${users.length}/${maxAuthorizedUsers})`];
  users.forEach((user, index) => {
    lines.push(`${index + 1}. ${displayName(user)} [${user.id}] via ${user.source}`);
  });
  return lines.join('\n');
}

function statusMessage(input: {
  monitorStatus: Record<string, unknown>;
  session: Record<string, unknown>;
  manualRunActive: boolean;
}): string {
  const monitorStatus = input.monitorStatus;
  const session = input.session;
  const lines = [
    'Campground bot status',
    `Scheduler: ${monitorStatus.schedulerEnabled ? 'running' : 'paused'}`,
    `Manual run: ${input.manualRunActive ? 'active' : 'idle'}`,
  ];

  if (monitorStatus.activeRun) {
    lines.push(`Active monitor run: ${monitorStatus.activeRun.mode} since ${monitorStatus.activeRun.startedAt}`);
  } else {
    lines.push(`Last check: ${formatSince(Number(monitorStatus.lastCheck) || 0)}`);
  }

  if (monitorStatus.lastError) {
    lines.push(`Last error: ${monitorStatus.lastError}`);
  }

  if (session.activeTask) {
    lines.push(`Active agent task: ${session.activeTask.runner} since ${session.activeTask.startedAt}`);
  } else {
    lines.push('Active agent task: none');
  }

  lines.push(`Pending uploads: ${Array.isArray(session.pendingUploads) ? session.pendingUploads.length : 0}`);
  if (session.repoStatus?.branch && session.repoStatus?.head) {
    lines.push(`Repo: ${session.repoStatus.branch} @ ${session.repoStatus.head}${session.repoStatus.clean ? '' : ' (dirty)'}`);
  }
  if (session.deployStatus) {
    lines.push(String(session.deployStatus));
  }

  if (session.lastResult) {
    lines.push(
      `Last agent result: ${session.lastResult.runner} ${session.lastResult.status} ${session.lastResult.finishedAt} (${formatDuration(session.lastResult.durationMs)})`
    );
    if (session.lastResult.summary) {
      lines.push(`Summary: ${previewText(session.lastResult.summary, 180)}`);
    }
  }

  if (Array.isArray(monitorStatus.runs) && monitorStatus.runs.length > 0) {
    lines.push('', 'Last 3 monitor runs:');
    monitorStatus.runs.forEach((run: Record<string, unknown>, index: number) => {
      lines.push(
        `${index + 1}. ${run.mode} ${run.success ? 'ok' : 'failed'} ${run.finishedAt} | alerts ${run.alertsSent}, openings ${run.facilitiesWithAvailability}, checks ${run.successfulChecks}/${run.checksAttempted}, ${formatDuration(Number(run.durationMs) || 0)}`
      );
    });
  }

  return lines.join('\n');
}

function logsMessage(input: {
  scope: string;
  monitorStatus: Record<string, unknown>;
  session: Record<string, unknown>;
}): string {
  const scope = String(input.scope || 'all').toLowerCase();
  const lines: string[] = [];

  if (scope === 'all' || scope === 'monitor') {
    lines.push('Monitor events');
    if (Array.isArray(input.monitorStatus.recentEvents) && input.monitorStatus.recentEvents.length > 0) {
      lines.push(...input.monitorStatus.recentEvents);
    } else {
      lines.push('No recent monitor events.');
    }
  }

  if (scope === 'all' || scope === 'runner') {
    if (lines.length > 0) lines.push('');
    lines.push('Runner logs');
    const result = input.session.lastResult;
    if (!result) {
      lines.push('No runner task has completed yet.');
    } else {
      lines.push(`${result.runner} ${result.status} at ${result.finishedAt}`);
      if (result.stdoutTail) {
        lines.push('', 'stdout tail:', tailText(result.stdoutTail, 1400));
      }
      if (result.stderrTail) {
        lines.push('', 'stderr tail:', tailText(result.stderrTail, 1200));
      }
      if (result.keptWorktreePath) {
        lines.push('', `kept worktree: ${relativeDisplayPath(result.keptWorktreePath, config.ROOT_DIR)}`);
      }
    }
  }

  return lines.join('\n');
}

function uploadQueuedMessage(uploads: Array<Record<string, unknown>>, totalPending: number): string {
  const names = uploads.map((upload) => upload.fileName || upload.kind).slice(0, 3).join(', ');
  return `Queued ${uploads.length} upload${uploads.length === 1 ? '' : 's'} for the next task. Pending now: ${totalPending}.${names ? ` Files: ${names}` : ''}`;
}

function runnerStartedMessage(activeTask: Record<string, unknown>): string {
  const lines = [
    `Starting ${String(activeTask.runner)}.`,
    `Task: ${previewText(activeTask.promptPreview, 140) || 'no prompt preview'}`,
  ];
  if (activeTask.uploadCount) {
    lines.push(`Uploads: ${activeTask.uploadCount}`);
  }
  if (Array.isArray(activeTask.warnings) && activeTask.warnings.length > 0) {
    lines.push(`Warnings: ${activeTask.warnings.join(' | ')}`);
  }
  return lines.join('\n');
}

function runnerProgressMessage(progress: Record<string, unknown>): string {
  const lines = [
    `${String(progress.runner)} still running after ${formatDuration(Number(progress.elapsedMs) || 0)}.`,
  ];
  if (progress.stdoutTail) {
    lines.push(`stdout: ${previewText(progress.stdoutTail, 220)}`);
  } else if (progress.stderrTail) {
    lines.push(`stderr: ${previewText(progress.stderrTail, 220)}`);
  }
  return lines.join('\n');
}

function runnerResultMessage(result: Record<string, unknown>, rootDir: string): string {
  const lines = [
    `${String(result.runner)} ${String(result.status)} in ${formatDuration(Number(result.durationMs) || 0)}.`,
  ];

  if (result.finalOutput) {
    lines.push('', String(result.finalOutput));
  } else if (result.summary) {
    lines.push('', String(result.summary));
  }

  if (result.branchName) lines.push('', `Branch: ${result.branchName}`);
  if (result.commitSha) lines.push(`Commit: ${result.commitSha}`);
  if (Array.isArray(result.changedFiles) && result.changedFiles.length > 0) {
    lines.push(`Files: ${result.changedFiles.join(', ')}`);
  }
  if (result.keptWorktreePath) {
    lines.push(`Worktree kept: ${relativeDisplayPath(String(result.keptWorktreePath), rootDir)}`);
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join(' | ')}`);
  }

  return lines.join('\n');
}

module.exports = {
  helpMessage,
  logsMessage,
  parseCommand,
  runnerProgressMessage,
  runnerResultMessage,
  runnerStartedMessage,
  statusMessage,
  uploadQueuedMessage,
  usersMessage,
};
