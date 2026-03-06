const config = require('./config.ts');
const { formatDuration, formatSince, previewLastLines, previewText, relativeDisplayPath, sanitizeText, tailText } = require('./utils.ts');
const { displayName } = require('./session-store.ts');

function parseCommand(rawText: string): Record<string, unknown> {
  const text = sanitizeText(rawText);
  if (!text) return { type: 'empty' };

  const slashMatch = text.match(/^\/([a-z][a-z0-9_-]*)(?:@[\w_]+)?(?:\s+(.*))?$/i);
  if (slashMatch) {
    const name = slashMatch[1].toLowerCase();
    const normalized = name.replace(/-/g, '_');
    const arg = sanitizeText(slashMatch[2] || '');
    if (normalized === 'start' || normalized === 'help') return { type: 'help' };
    if (normalized === 'status') return { type: 'status' };
    if (normalized === 'scope' || normalized === 'targets' || normalized === 'parks') return { type: 'scope' };
    if (normalized === 'run_now' || normalized === 'runnow' || normalized === 'check' || normalized === 'check_now') {
      return { type: 'run-monitor' };
    }
    if (normalized === 'pause_monitor' || normalized === 'pause') return { type: 'pause-monitor' };
    if (normalized === 'resume_monitor' || normalized === 'resume') return { type: 'resume-monitor' };
    if (normalized === 'restart_monitor' || normalized === 'restart') return { type: 'restart-monitor' };
    if (normalized === 'users') return { type: 'users' };
    if (normalized === 'forget' || normalized === 'clear' || normalized === 'reset') return { type: 'forget' };
    if (normalized === 'cancel') return { type: 'cancel' };
    if (normalized === 'apply') return { type: 'apply', ref: arg };
    if (normalized === 'deploy') return { type: 'deploy' };
    if (normalized === 'logs') return { type: 'logs', scope: arg || 'all' };
    if (normalized === 'claude') return { type: 'runner', runner: 'claude', prompt: arg };
    if (normalized === 'codex') return { type: 'runner', runner: 'codex', prompt: arg };
  }

  const lower = text.toLowerCase();
  if (/^(help|\?|actions?)$/.test(lower)) return { type: 'help' };
  if (/^(status|health|overview)$/.test(lower)) return { type: 'status' };
  if (
    /^(scope|targets|parks|what are you checking|what campsites are you checking|what campgrounds are you checking|what parks are you checking|which campsites are you checking|which campgrounds are you checking)\??$/.test(
      lower
    )
  ) {
    return { type: 'scope' };
  }
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
    '/scope',
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
    const progressBits: string[] = [];
    const totalChecks = Number(monitorStatus.activeRun.totalChecks) || 0;
    const checksAttempted = Number(monitorStatus.activeRun.checksAttempted) || 0;
    const successfulChecks = Number(monitorStatus.activeRun.successfulChecks) || 0;
    const facilitiesWithAvailability = Number(monitorStatus.activeRun.facilitiesWithAvailability) || 0;
    const currentParkName = sanitizeText(monitorStatus.activeRun.currentParkName || '');
    const currentFacilityName = sanitizeText(monitorStatus.activeRun.currentFacilityName || '');
    const currentRangeLabel = sanitizeText(monitorStatus.activeRun.currentRangeLabel || '');

    if (totalChecks > 0) {
      progressBits.push(`progress ${checksAttempted}/${totalChecks}`);
    }
    if (successfulChecks > 0) {
      progressBits.push(`responses ${successfulChecks}`);
    }
    if (facilitiesWithAvailability > 0) {
      progressBits.push(`openings ${facilitiesWithAvailability}`);
    }
    if (currentParkName && currentFacilityName && currentRangeLabel) {
      progressBits.push(`current ${currentParkName} / ${currentFacilityName} / ${currentRangeLabel}`);
    }

    lines.push(
      `Active monitor run: ${monitorStatus.activeRun.mode} since ${monitorStatus.activeRun.startedAt}${
        progressBits.length > 0 ? ` | ${progressBits.join(', ')}` : ''
      }`
    );
  } else {
    lines.push(`Last check: ${formatSince(Number(monitorStatus.lastCheck) || 0)}`);
  }

  if (monitorStatus.lastError) {
    lines.push(`Last error: ${monitorStatus.lastError}`);
  }

  if (session.activeTask) {
    lines.push(`Active agent task: ${session.activeTask.runner} since ${session.activeTask.startedAt}`);
    if (session.activeTask.statusStage) {
      lines.push(`Agent stage: ${session.activeTask.statusStage}`);
    }
    if (session.activeTask.statusSummary) {
      lines.push(`Agent summary: ${session.activeTask.statusSummary}`);
    }
    if (session.activeTask.statusHypothesis) {
      lines.push(`Agent hypothesis: ${session.activeTask.statusHypothesis}`);
    }
    if (session.activeTask.statusEvidence) {
      lines.push(`Agent evidence: ${session.activeTask.statusEvidence}`);
    }
    if (session.activeTask.statusDecision) {
      lines.push(`Agent decision: ${session.activeTask.statusDecision}`);
    }
    if (session.activeTask.statusNextStep) {
      lines.push(`Agent next step: ${session.activeTask.statusNextStep}`);
    }
    if (session.activeTask.branchName) {
      lines.push(`Agent branch: ${session.activeTask.branchName}`);
    }
    if (session.activeTask.worktreePath) {
      lines.push(`Agent worktree: ${relativeDisplayPath(String(session.activeTask.worktreePath), config.ROOT_DIR)}`);
    }
    if (session.activeTask.commandSummary) {
      lines.push(`Agent command: ${session.activeTask.commandSummary}`);
    }
    if (Array.isArray(session.activeTask.changedFiles) && session.activeTask.changedFiles.length > 0) {
      lines.push(
        `Agent changed files: ${session.activeTask.changedFiles.join(', ')}${
          session.activeTask.changedFileCount > session.activeTask.changedFiles.length
            ? ` (+${session.activeTask.changedFileCount - session.activeTask.changedFiles.length} more)`
            : ''
        }`
      );
    } else {
      lines.push('Agent changed files: none yet');
    }
    if (session.activeTask.stdoutTail) {
      lines.push(`Agent stdout: ${previewText(session.activeTask.stdoutTail, 180)}`);
    } else if (session.activeTask.stderrTail) {
      lines.push(`Agent stderr: ${previewText(session.activeTask.stderrTail, 180)}`);
    } else if (session.activeTask.lastProgressAt) {
      lines.push(`Agent output: none visible as of ${session.activeTask.lastProgressAt}`);
    }
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
    if (!session.lastResult.finalOutput && session.lastResult.lastKnownStage) {
      lines.push(`Last stage: ${session.lastResult.lastKnownStage}`);
    }
    if (!session.lastResult.finalOutput && session.lastResult.lastKnownSummary) {
      lines.push(`Last summary: ${previewText(session.lastResult.lastKnownSummary, 180)}`);
    }
    if (!session.lastResult.finalOutput && session.lastResult.lastKnownHypothesis) {
      lines.push(`Last hypothesis: ${previewText(session.lastResult.lastKnownHypothesis, 180)}`);
    }
    if (!session.lastResult.finalOutput && session.lastResult.lastKnownEvidence) {
      lines.push(`Last evidence: ${previewText(session.lastResult.lastKnownEvidence, 180)}`);
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

    const activeTask = input.session.activeTask;
    if (activeTask) {
      lines.push(`Active ${activeTask.runner} task since ${activeTask.startedAt}`);
      if (activeTask.statusStage) {
        lines.push(`Stage: ${activeTask.statusStage}`);
      }
      if (activeTask.statusSummary) {
        lines.push(`Summary: ${previewText(activeTask.statusSummary, 220)}`);
      }
      if (activeTask.statusHypothesis) {
        lines.push(`Hypothesis: ${previewText(activeTask.statusHypothesis, 220)}`);
      }
      if (activeTask.statusEvidence) {
        lines.push(`Evidence: ${previewText(activeTask.statusEvidence, 220)}`);
      }
      if (activeTask.statusDecision) {
        lines.push(`Decision: ${previewText(activeTask.statusDecision, 220)}`);
      }
      if (activeTask.statusNextStep) {
        lines.push(`Next step: ${previewText(activeTask.statusNextStep, 220)}`);
      }
      if (Array.isArray(activeTask.changedFiles) && activeTask.changedFiles.length > 0) {
        lines.push(
          `Changed files: ${activeTask.changedFiles.join(', ')}${
            Number(activeTask.changedFileCount) > activeTask.changedFiles.length
              ? ` (+${Number(activeTask.changedFileCount) - activeTask.changedFiles.length} more)`
              : ''
          }`
        );
      }
      if (activeTask.stdoutTail) {
        lines.push('', 'live stdout tail:', tailText(activeTask.stdoutTail, 1400));
      }
      if (activeTask.stderrTail) {
        lines.push('', 'live stderr tail:', tailText(activeTask.stderrTail, 1200));
      }
      if (!activeTask.stdoutTail && !activeTask.stderrTail) {
        lines.push('No live stdout or stderr yet.');
      }
    }

    const result = input.session.lastResult;
    if (result) {
      if (activeTask) {
        lines.push('', 'Last completed runner result');
      }
      lines.push(`${result.runner} ${result.status} at ${result.finishedAt}`);
      if (result.summary) {
        lines.push(`Summary: ${previewText(result.summary, 220)}`);
      }
      if (result.lastKnownStage) {
        lines.push(`Last stage: ${result.lastKnownStage}`);
      }
      if (result.lastKnownSummary) {
        lines.push(`Last summary: ${previewText(result.lastKnownSummary, 220)}`);
      }
      if (result.lastKnownHypothesis) {
        lines.push(`Last hypothesis: ${previewText(result.lastKnownHypothesis, 220)}`);
      }
      if (result.lastKnownEvidence) {
        lines.push(`Last evidence: ${previewText(result.lastKnownEvidence, 220)}`);
      }
      if (result.lastKnownDecision) {
        lines.push(`Last decision: ${previewText(result.lastKnownDecision, 220)}`);
      }
      if (result.lastKnownNextStep) {
        lines.push(`Last next step: ${previewText(result.lastKnownNextStep, 220)}`);
      }
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

    if (!activeTask && !result) {
      lines.push('No runner task is active and no runner task has completed yet.');
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
  lines.push('I will stream live tool activity, partial reply text, status, and file changes when available.');
  lines.push('Send /status at any time for the full live task details.');
  if (Array.isArray(activeTask.warnings) && activeTask.warnings.length > 0) {
    lines.push(`Warnings: ${activeTask.warnings.join(' | ')}`);
  }
  return lines.join('\n');
}

function runnerCardMessage(input: Record<string, unknown>): string {
  const status = String(input.status || 'running');
  const runner = String(input.runner || 'runner');
  const promptPreview = previewText(input.promptPreview, 140) || 'no prompt preview';
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const stdoutChunk = input.stdoutChunk ? String(input.stdoutChunk).trim() : '';
  const stderrChunk = input.stderrChunk ? String(input.stderrChunk).trim() : '';
  const statusBits = [
    input.statusStage ? `Stage: ${input.statusStage}` : null,
    input.statusSummary ? `Summary: ${previewText(input.statusSummary, 220)}` : null,
    input.statusHypothesis ? `Hypothesis: ${previewText(input.statusHypothesis, 220)}` : null,
    input.statusEvidence ? `Evidence: ${previewText(input.statusEvidence, 220)}` : null,
    input.statusDecision ? `Decision: ${previewText(input.statusDecision, 220)}` : null,
    input.statusNextStep ? `Next: ${previewText(input.statusNextStep, 220)}` : null,
  ].filter(Boolean);

  const lines = [
    `${runner} ${status === 'running' ? 'running' : status} ${
      status === 'running' ? `for ${formatDuration(Number(input.elapsedMs) || 0)}` : `in ${formatDuration(Number(input.durationMs) || 0)}`
    }.`,
    `Task: ${promptPreview}`,
  ];

  if (status === 'running' && Boolean(input.heartbeat)) {
    lines.push(`No new visible activity for ${formatDuration(Number(input.idleMs) || 0)}.`);
  }

  lines.push(...statusBits);

  if (changedFiles.length > 0) {
    lines.push(
      `Changed files: ${changedFiles.join(', ')}${
        Number(input.changedFileCount) > changedFiles.length ? ` (+${Number(input.changedFileCount) - changedFiles.length} more)` : ''
      }`
    );
  }

  const outputPreview = previewLastLines(stdoutChunk, 4, 320);
  const stderrPreview = previewLastLines(stderrChunk, 4, 320);
  if (outputPreview) {
    lines.push('Output:');
    lines.push(outputPreview);
  } else if (stderrPreview) {
    lines.push('stderr:');
    lines.push(stderrPreview);
  }

  if (status !== 'running' && input.summary) {
    lines.push(`Summary: ${previewText(input.summary, 260)}`);
  }

  if (status !== 'running' && input.commitSha) {
    lines.push(`Commit: ${input.commitSha}`);
  }

  if (status !== 'running' && Array.isArray(input.warnings) && input.warnings.length > 0) {
    lines.push(`Warnings: ${input.warnings.join(' | ')}`);
  }

  lines.push(status === 'running' ? 'Use the buttons below or /status for details.' : 'Use the buttons below or /logs runner for details.');
  return lines.join('\n');
}

function manualRunStartedMessage(scope: Record<string, unknown>): string {
  const totalChecks = Number(scope.totalChecks) || 0;
  const targetCount = Number(scope.targetCount) || 0;
  const rangeCount = Number(scope.rangeCount) || 0;
  return [
    'Starting a manual campsite check now.',
    `Scope: ${totalChecks} checks across ${targetCount} campground targets and ${rangeCount} date ranges.`,
    'Typical runtime: about 35-45s.',
  ].join('\n');
}

function manualRunProgressMessage(activeRun: Record<string, unknown>): string {
  const startedAt = Date.parse(String(activeRun.startedAt || ''));
  const elapsedMs = Number.isNaN(startedAt) ? 0 : Date.now() - startedAt;
  const totalChecks = Number(activeRun.totalChecks) || 0;
  const checksAttempted = Number(activeRun.checksAttempted) || 0;
  const successfulChecks = Number(activeRun.successfulChecks) || 0;
  const facilitiesWithAvailability = Number(activeRun.facilitiesWithAvailability) || 0;
  const currentParkName = sanitizeText(activeRun.currentParkName || '');
  const currentFacilityName = sanitizeText(activeRun.currentFacilityName || '');
  const currentRangeLabel = sanitizeText(activeRun.currentRangeLabel || '');

  const lines = [`Manual campsite check running for ${formatDuration(elapsedMs)}.`];
  if (totalChecks > 0) {
    lines.push(`Progress: ${checksAttempted}/${totalChecks} checks, ${successfulChecks} successful responses.`);
  }
  if (currentParkName && currentFacilityName && currentRangeLabel) {
    lines.push(`Current: ${currentParkName} / ${currentFacilityName} / ${currentRangeLabel}`);
  }
  lines.push(`Openings found so far: ${facilitiesWithAvailability}`);
  return lines.join('\n');
}

function runnerProgressMessage(progress: Record<string, unknown>): string {
  const elapsed = formatDuration(Number(progress.elapsedMs) || 0);
  const changedFiles = Array.isArray(progress.changedFiles) ? progress.changedFiles : [];
  const stdoutChunk = progress.stdoutChunk ? String(progress.stdoutChunk).trim() : '';
  const stderrChunk = progress.stderrChunk ? String(progress.stderrChunk).trim() : '';
  const statusBits = [
    progress.statusStage ? `Stage: ${progress.statusStage}` : null,
    progress.statusSummary ? `Summary: ${previewText(progress.statusSummary, 220)}` : null,
    progress.statusHypothesis ? `Hypothesis: ${previewText(progress.statusHypothesis, 220)}` : null,
    progress.statusEvidence ? `Evidence: ${previewText(progress.statusEvidence, 220)}` : null,
    progress.statusDecision ? `Decision: ${previewText(progress.statusDecision, 220)}` : null,
    progress.statusNextStep ? `Next: ${previewText(progress.statusNextStep, 220)}` : null,
  ].filter(Boolean);

  const lines = [`${String(progress.runner)} live at ${elapsed}.`];
  if (progress.heartbeat) {
    const idle = formatDuration(Number(progress.idleMs) || 0);
    lines.push(`No new output for ${idle}, but the task is still running.`);
  }
  lines.push(...statusBits);
  if (changedFiles.length > 0) {
    lines.push(
      `Changed files: ${changedFiles.join(', ')}${
        Number(progress.changedFileCount) > changedFiles.length ? ` (+${Number(progress.changedFileCount) - changedFiles.length} more)` : ''
      }`
    );
  }
  if (stdoutChunk) {
    lines.push('', 'Output:', stdoutChunk);
  } else if (stderrChunk) {
    lines.push('', 'stderr:', stderrChunk);
  }
  lines.push('Send /status for the full live task details.');
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

  if (!result.finalOutput && result.lastKnownStage) lines.push(`Last stage: ${result.lastKnownStage}`);
  if (!result.finalOutput && result.lastKnownSummary) lines.push(`Last summary: ${result.lastKnownSummary}`);
  if (!result.finalOutput && result.lastKnownHypothesis) lines.push(`Last hypothesis: ${result.lastKnownHypothesis}`);
  if (!result.finalOutput && result.lastKnownEvidence) lines.push(`Last evidence: ${result.lastKnownEvidence}`);
  if (!result.finalOutput && result.lastKnownDecision) lines.push(`Last decision: ${result.lastKnownDecision}`);
  if (!result.finalOutput && result.lastKnownNextStep) lines.push(`Last next step: ${result.lastKnownNextStep}`);

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
  manualRunProgressMessage,
  manualRunStartedMessage,
  parseCommand,
  runnerCardMessage,
  runnerProgressMessage,
  runnerResultMessage,
  runnerStartedMessage,
  statusMessage,
  uploadQueuedMessage,
  usersMessage,
};
