const config = require('./config.ts');
const { formatDuration, formatSince, previewLastLines, previewText, relativeDisplayPath, sanitizeText, tailText } = require('./utils.ts');
const { displayName } = require('./session-store.ts');

function runnerStatusEmoji(status: unknown): string {
  const value = String(status || '').toLowerCase();
  if (value === 'running') return '🟡';
  if (value === 'completed') return '✅';
  if (value === 'failed') return '❌';
  if (value === 'cancelled') return '🛑';
  if (value === 'timeout') return '⏱️';
  return 'ℹ️';
}

function stageEmoji(stage: unknown): string {
  const value = String(stage || '').toLowerCase();
  if (value === 'planning') return '🧭';
  if (value === 'editing') return '✍️';
  if (value === 'testing') return '🧪';
  if (value === 'replying') return '💬';
  return 'ℹ️';
}

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
    '<b>Campground bot commands</b>',
    '',
    '<code>/status</code>',
    '<code>/scope</code>',
    '<code>/run-now</code>',
    '<code>/pause-monitor</code>',
    '<code>/resume-monitor</code>',
    '<code>/restart-monitor</code>',
    '<code>/logs</code> [monitor|runner]',
    '<code>/users</code>',
    '<code>/forget</code>',
    '<code>/cancel</code>',
    '<code>/apply</code> [commit-or-branch]',
    '<code>/deploy</code>',
    '<code>/claude</code> &lt;task&gt;',
    '<code>/codex</code> &lt;task&gt;',
    '',
    'Successful code changes are auto-applied to main.',
    'Runtime-affecting changes are auto-deployed after apply.',
    'Plain text defaults to Claude.',
    'Reply to a task card to keep talking to that specific Claude or Codex agent.',
    'Uploads with no text are queued for the next Claude or Codex task.',
  ].join('\n');
}

function usersMessage(users: Array<Record<string, unknown>>, maxAuthorizedUsers: number): string {
  const lines = [`<b>Authorized users (${users.length}/${maxAuthorizedUsers})</b>`];
  users.forEach((user, index) => {
    lines.push(`${index + 1}. <b>${escapeHtml(displayName(user))}</b> [${escapeHtml(String(user.id || ''))}] via ${escapeHtml(String(user.source || ''))}`);
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
  const esc = escapeHtml;
  const lines = [
    '<b>Campground bot status</b>',
    `<b>Scheduler:</b> ${monitorStatus.schedulerEnabled ? 'running' : 'paused'}`,
    `<b>Manual run:</b> ${input.manualRunActive ? 'active' : 'idle'}`,
  ];
  const activeTasks = Array.isArray(session.activeTasks) ? session.activeTasks : session.activeTask ? [session.activeTask] : [];

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
      progressBits.push(`current ${esc(currentParkName)} / ${esc(currentFacilityName)} / ${esc(currentRangeLabel)}`);
    }

    lines.push(
      `<b>Active monitor run:</b> ${esc(String(monitorStatus.activeRun.mode || ''))} since ${esc(String(monitorStatus.activeRun.startedAt || ''))}${
        progressBits.length > 0 ? ` | ${progressBits.join(', ')}` : ''
      }`
    );
  } else {
    lines.push(`<b>Last check:</b> ${esc(formatSince(Number(monitorStatus.lastCheck) || 0))}`);
  }

  if (monitorStatus.lastError) {
    lines.push(`<b>Last error:</b> ${esc(String(monitorStatus.lastError))}`);
  }

  if (activeTasks.length > 1) {
    lines.push(`<b>Active agent tasks:</b> ${activeTasks.length}`);
  }

  if (session.activeTask) {
    lines.push(`${runnerStatusEmoji('running')} <b>Active agent task:</b> ${esc(String(session.activeTask.runner || ''))} since ${esc(String(session.activeTask.startedAt || ''))}`);
    if (session.activeTask.statusStage) {
      lines.push(`${stageEmoji(session.activeTask.statusStage)} <b>Agent stage:</b> ${esc(String(session.activeTask.statusStage))}`);
    }
    if (session.activeTask.statusSummary) {
      lines.push(`📝 <b>Agent summary:</b> ${esc(previewText(session.activeTask.statusSummary, 180))}`);
    }
    if (session.activeTask.statusHypothesis) {
      lines.push(`💭 <b>Agent hypothesis:</b> ${esc(previewText(session.activeTask.statusHypothesis, 180))}`);
    }
    if (session.activeTask.statusEvidence) {
      lines.push(`🔎 <b>Agent evidence:</b> ${esc(previewText(session.activeTask.statusEvidence, 180))}`);
    }
    if (session.activeTask.statusDecision) {
      lines.push(`⚖️ <b>Agent decision:</b> ${esc(previewText(session.activeTask.statusDecision, 180))}`);
    }
    if (session.activeTask.statusNextStep) {
      lines.push(`➡️ <b>Agent next step:</b> ${esc(previewText(session.activeTask.statusNextStep, 180))}`);
    }
    if (session.activeTask.branchName) {
      lines.push(`<b>Agent branch:</b> <code>${esc(String(session.activeTask.branchName))}</code>`);
    }
    if (session.activeTask.worktreePath) {
      lines.push(`<b>Agent worktree:</b> <code>${esc(relativeDisplayPath(String(session.activeTask.worktreePath), config.ROOT_DIR))}</code>`);
    }
    if (session.activeTask.commandSummary) {
      lines.push(`<b>Agent command:</b> ${esc(String(session.activeTask.commandSummary))}`);
    }
    if (Array.isArray(session.activeTask.changedFiles) && session.activeTask.changedFiles.length > 0) {
      lines.push(
        `<b>Agent changed files:</b> <code>${esc(session.activeTask.changedFiles.join(', '))}${
          session.activeTask.changedFileCount > session.activeTask.changedFiles.length
            ? ` (+${session.activeTask.changedFileCount - session.activeTask.changedFiles.length} more)`
            : ''
        }</code>`
      );
    } else {
      lines.push('<b>Agent changed files:</b> none yet');
    }
    if (session.activeTask.stdoutTail) {
      lines.push(`<b>Agent stdout:</b> ${esc(previewText(session.activeTask.stdoutTail, 180))}`);
    } else if (session.activeTask.stderrTail) {
      lines.push(`<b>Agent stderr:</b> ${esc(previewText(session.activeTask.stderrTail, 180))}`);
    } else if (session.activeTask.lastProgressAt) {
      lines.push(`<b>Agent output:</b> none visible as of ${esc(String(session.activeTask.lastProgressAt))}`);
    }
  } else {
    lines.push('<b>Active agent task:</b> none');
  }

  lines.push(`<b>Pending uploads:</b> ${Array.isArray(session.pendingUploads) ? session.pendingUploads.length : 0}`);
  if (session.repoStatus?.branch && session.repoStatus?.head) {
    lines.push(`<b>Repo:</b> <code>${esc(String(session.repoStatus.branch))} @ ${esc(String(session.repoStatus.head))}${session.repoStatus.clean ? '' : ' (dirty)'}</code>`);
  }
  if (session.deployStatus) {
    lines.push(esc(String(session.deployStatus)));
  }

  if (session.lastResult) {
    lines.push(
      `${runnerStatusEmoji(session.lastResult.status)} <b>Last agent result:</b> ${esc(String(session.lastResult.runner || ''))} ${esc(String(session.lastResult.status || ''))} ${esc(String(session.lastResult.finishedAt || ''))} (${esc(formatDuration(session.lastResult.durationMs))})`
    );
    if (session.lastResult.summary) {
      lines.push(`📝 <b>Summary:</b> ${esc(previewText(session.lastResult.summary, 180))}`);
    }
    if (!session.lastResult.finalOutput && session.lastResult.lastKnownStage) {
      lines.push(`${stageEmoji(session.lastResult.lastKnownStage)} <b>Last stage:</b> ${esc(String(session.lastResult.lastKnownStage))}`);
    }
    if (!session.lastResult.finalOutput && session.lastResult.lastKnownSummary) {
      lines.push(`📝 <b>Last summary:</b> ${esc(previewText(session.lastResult.lastKnownSummary, 180))}`);
    }
    if (!session.lastResult.finalOutput && session.lastResult.lastKnownHypothesis) {
      lines.push(`💭 <b>Last hypothesis:</b> ${esc(previewText(session.lastResult.lastKnownHypothesis, 180))}`);
    }
    if (!session.lastResult.finalOutput && session.lastResult.lastKnownEvidence) {
      lines.push(`🔎 <b>Last evidence:</b> ${esc(previewText(session.lastResult.lastKnownEvidence, 180))}`);
    }
  }

  if (Array.isArray(monitorStatus.runs) && monitorStatus.runs.length > 0) {
    lines.push('', '<b>Last 3 monitor runs:</b>');
    monitorStatus.runs.forEach((run: Record<string, unknown>, index: number) => {
      lines.push(
        `${index + 1}. ${esc(String(run.mode || ''))} ${run.success ? 'ok' : 'failed'} ${esc(String(run.finishedAt || ''))} | alerts ${run.alertsSent}, openings ${run.facilitiesWithAvailability}, checks ${run.successfulChecks}/${run.checksAttempted}, ${formatDuration(Number(run.durationMs) || 0)}`
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
  const esc = escapeHtml;
  const lines: string[] = [];

  if (scope === 'all' || scope === 'monitor') {
    lines.push('<b>Monitor events</b>');
    if (Array.isArray(input.monitorStatus.recentEvents) && input.monitorStatus.recentEvents.length > 0) {
      lines.push(...input.monitorStatus.recentEvents.map((e: unknown) => esc(String(e))));
    } else {
      lines.push('No recent monitor events.');
    }
  }

  if (scope === 'all' || scope === 'runner') {
    if (lines.length > 0) lines.push('');
    lines.push('<b>Runner logs</b>');
    const activeTasks = Array.isArray(input.session.activeTasks) ? input.session.activeTasks : input.session.activeTask ? [input.session.activeTask] : [];
    if (activeTasks.length > 1) {
      lines.push(`<b>Active agent tasks:</b> ${activeTasks.length}`);
    }

    const activeTask = input.session.activeTask;
    if (activeTask) {
      lines.push(`${runnerStatusEmoji('running')} <b>Active ${esc(String(activeTask.runner || ''))} task since ${esc(String(activeTask.startedAt || ''))}</b>`);
      if (activeTask.statusStage) {
        lines.push(`${stageEmoji(activeTask.statusStage)} <b>Stage:</b> ${esc(String(activeTask.statusStage))}`);
      }
      if (activeTask.statusSummary) {
        lines.push(`📝 <b>Summary:</b> ${esc(previewText(activeTask.statusSummary, 220))}`);
      }
      if (activeTask.statusHypothesis) {
        lines.push(`💭 <b>Hypothesis:</b> ${esc(previewText(activeTask.statusHypothesis, 220))}`);
      }
      if (activeTask.statusEvidence) {
        lines.push(`🔎 <b>Evidence:</b> ${esc(previewText(activeTask.statusEvidence, 220))}`);
      }
      if (activeTask.statusDecision) {
        lines.push(`⚖️ <b>Decision:</b> ${esc(previewText(activeTask.statusDecision, 220))}`);
      }
      if (activeTask.statusNextStep) {
        lines.push(`➡️ <b>Next step:</b> ${esc(previewText(activeTask.statusNextStep, 220))}`);
      }
      if (Array.isArray(activeTask.changedFiles) && activeTask.changedFiles.length > 0) {
        lines.push(
          `<b>Changed files:</b> <code>${esc(activeTask.changedFiles.join(', '))}${
            Number(activeTask.changedFileCount) > activeTask.changedFiles.length
              ? ` (+${Number(activeTask.changedFileCount) - activeTask.changedFiles.length} more)`
              : ''
          }</code>`
        );
      }
      if (activeTask.stdoutTail) {
        lines.push('', '📤 <b>live stdout tail:</b>', `<pre>${esc(tailText(activeTask.stdoutTail, 1400))}</pre>`);
      }
      if (activeTask.stderrTail) {
        lines.push('', '⚠️ <b>live stderr tail:</b>', `<pre>${esc(tailText(activeTask.stderrTail, 1200))}</pre>`);
      }
      if (!activeTask.stdoutTail && !activeTask.stderrTail) {
        lines.push('No live stdout or stderr yet.');
      }
    }

    const result = input.session.lastResult;
    if (result) {
      if (activeTask) {
        lines.push('', '<b>Last completed runner result</b>');
      }
      lines.push(`${runnerStatusEmoji(result.status)} <b>${esc(String(result.runner || ''))} ${esc(String(result.status || ''))} at ${esc(String(result.finishedAt || ''))}</b>`);
      if (result.summary) {
        lines.push(`📝 <b>Summary:</b> ${esc(previewText(result.summary, 220))}`);
      }
      if (result.lastKnownStage) {
        lines.push(`${stageEmoji(result.lastKnownStage)} <b>Last stage:</b> ${esc(String(result.lastKnownStage))}`);
      }
      if (result.lastKnownSummary) {
        lines.push(`📝 <b>Last summary:</b> ${esc(previewText(result.lastKnownSummary, 220))}`);
      }
      if (result.lastKnownHypothesis) {
        lines.push(`💭 <b>Last hypothesis:</b> ${esc(previewText(result.lastKnownHypothesis, 220))}`);
      }
      if (result.lastKnownEvidence) {
        lines.push(`🔎 <b>Last evidence:</b> ${esc(previewText(result.lastKnownEvidence, 220))}`);
      }
      if (result.lastKnownDecision) {
        lines.push(`⚖️ <b>Last decision:</b> ${esc(previewText(result.lastKnownDecision, 220))}`);
      }
      if (result.lastKnownNextStep) {
        lines.push(`➡️ <b>Last next step:</b> ${esc(previewText(result.lastKnownNextStep, 220))}`);
      }
      if (result.stdoutTail) {
        lines.push('', '📤 <b>stdout tail:</b>', `<pre>${esc(tailText(result.stdoutTail, 1400))}</pre>`);
      }
      if (result.stderrTail) {
        lines.push('', '⚠️ <b>stderr tail:</b>', `<pre>${esc(tailText(result.stderrTail, 1200))}</pre>`);
      }
      if (result.keptWorktreePath) {
        lines.push('', `<b>Kept worktree:</b> <code>${esc(relativeDisplayPath(result.keptWorktreePath, config.ROOT_DIR))}</code>`);
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
  return `Queued ${uploads.length} upload${uploads.length === 1 ? '' : 's'} for the next task. Pending now: ${totalPending}.${names ? ` Files: <code>${escapeHtml(names)}</code>` : ''}`;
}

function runnerStartedMessage(activeTask: Record<string, unknown>): string {
  const lines = [
    `<b>Starting ${escapeHtml(String(activeTask.runner || ''))}.</b>`,
    `<b>Task:</b> ${escapeHtml(previewText(activeTask.promptPreview, 140) || 'no prompt preview')}`,
  ];
  if (activeTask.uploadCount) {
    lines.push(`<b>Uploads:</b> ${activeTask.uploadCount}`);
  }
  lines.push('I will stream live tool activity, partial reply text, status, and file changes when available.');
  if (Array.isArray(activeTask.warnings) && activeTask.warnings.length > 0) {
    lines.push(`<b>Warnings:</b> ${escapeHtml(activeTask.warnings.join(' | '))}`);
  }
  return lines.join('\n');
}

function escapeHtml(text: unknown): string {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function runnerCardMessage(input: Record<string, unknown>): string {
  const status = String(input.status || 'running');
  const runner = String(input.runner || 'runner');
  const promptPreview = previewText(input.promptPreview, 140) || 'no prompt preview';
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const postActions = Array.isArray(input.postActions) ? input.postActions.map((value) => String(value).trim()).filter(Boolean) : [];
  const stdoutChunk = input.stdoutChunk ? String(input.stdoutChunk).trim() : '';
  const stdoutTail = input.stdoutTail ? String(input.stdoutTail).trim() : '';
  const stderrChunk = input.stderrChunk ? String(input.stderrChunk).trim() : '';
  const stderrTail = input.stderrTail ? String(input.stderrTail).trim() : '';
  const statusBits = [
    input.statusStage ? `${stageEmoji(input.statusStage)} <b>Stage:</b> ${escapeHtml(input.statusStage)}` : null,
    input.statusSummary ? `📝 <b>Summary:</b> ${escapeHtml(previewText(input.statusSummary, 220))}` : null,
    input.statusHypothesis ? `💭 <b>Hypothesis:</b> ${escapeHtml(previewText(input.statusHypothesis, 220))}` : null,
    input.statusEvidence ? `🔎 <b>Evidence:</b> ${escapeHtml(previewText(input.statusEvidence, 220))}` : null,
    input.statusDecision ? `⚖️ <b>Decision:</b> ${escapeHtml(previewText(input.statusDecision, 220))}` : null,
    input.statusNextStep ? `➡️ <b>Next:</b> ${escapeHtml(previewText(input.statusNextStep, 220))}` : null,
  ].filter(Boolean);

  const sections: string[][] = [];

  const header = [
    `${runnerStatusEmoji(status)} <b>${runner} ${status === 'running' ? 'running' : status} ${
      status === 'running' ? `for ${formatDuration(Number(input.elapsedMs) || 0)}` : `in ${formatDuration(Number(input.durationMs) || 0)}`
    }</b>`,
    `<b>Task:</b> ${escapeHtml(promptPreview)}`,
  ];
  if (status === 'running' && Boolean(input.heartbeat)) {
    header.push(`No new visible activity for ${formatDuration(Number(input.idleMs) || 0)}.`);
  }
  sections.push(header);

  if (statusBits.length > 0) {
    sections.push(statusBits as string[]);
  }

  if (changedFiles.length > 0) {
    sections.push([
      `<b>Changed files:</b> ${escapeHtml(changedFiles.join(', '))}${
        Number(input.changedFileCount) > changedFiles.length ? ` (+${Number(input.changedFileCount) - changedFiles.length} more)` : ''
      }`,
    ]);
  }

  const outputPreview = previewLastLines(stdoutTail || stdoutChunk, 8, 700) || previewLastLines(stdoutChunk, 8, 700);
  const stderrPreview = previewLastLines(stderrTail || stderrChunk, 6, 600) || previewLastLines(stderrChunk, 6, 600);
  if (outputPreview) {
    sections.push([`📤 <b>Output:</b>`, escapeHtml(outputPreview)]);
  } else if (stderrPreview) {
    sections.push([`⚠️ <b>stderr:</b>`, escapeHtml(stderrPreview)]);
  }

  if (status !== 'running' && input.finalOutput) {
    const finalOutputPreview = previewLastLines(input.finalOutput, 10, 900) || previewText(input.finalOutput, 900);
    if (finalOutputPreview) {
      sections.push([`💬 <b>Result:</b>`, finalOutputPreview]);
    }
  }

  const meta: string[] = [];
  if (status !== 'running' && input.summary) {
    meta.push(`📝 <b>Summary:</b> ${escapeHtml(previewText(input.summary, 260))}`);
  }
  if (status !== 'running' && input.commitSha) {
    meta.push(`Commit: <code>${escapeHtml(String(input.commitSha))}</code>`);
  }
  if (status !== 'running' && postActions.length > 0) {
    meta.push('<b>📌 Actions:</b>');
    meta.push(...postActions.map((line) => `- ${escapeHtml(line)}`));
  }
  if (status !== 'running' && Array.isArray(input.warnings) && input.warnings.length > 0) {
    meta.push(`⚠️ <b>Warnings:</b> ${escapeHtml(input.warnings.join(' | '))}`);
  }
  if (meta.length > 0) {
    sections.push(meta);
  }

  return sections.map((s) => s.join('\n')).join('\n\n');
}

function manualRunStartedMessage(scope: Record<string, unknown>): string {
  const totalChecks = Number(scope.totalChecks) || 0;
  const targetCount = Number(scope.targetCount) || 0;
  const rangeCount = Number(scope.rangeCount) || 0;
  return [
    '<b>Starting a manual campsite check now.</b>',
    `<b>Scope:</b> ${totalChecks} checks across ${targetCount} campground targets and ${rangeCount} date ranges.`,
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

  const lines = [`<b>Manual campsite check running for ${formatDuration(elapsedMs)}.</b>`];
  if (totalChecks > 0) {
    lines.push(`<b>Progress:</b> ${checksAttempted}/${totalChecks} checks, ${successfulChecks} successful responses.`);
  }
  if (currentParkName && currentFacilityName && currentRangeLabel) {
    lines.push(`<b>Current:</b> ${escapeHtml(currentParkName)} / ${escapeHtml(currentFacilityName)} / ${escapeHtml(currentRangeLabel)}`);
  }
  lines.push(`<b>Openings found so far:</b> ${facilitiesWithAvailability}`);
  return lines.join('\n');
}

function runnerProgressMessage(progress: Record<string, unknown>): string {
  const elapsed = formatDuration(Number(progress.elapsedMs) || 0);
  const changedFiles = Array.isArray(progress.changedFiles) ? progress.changedFiles : [];
  const stdoutChunk = progress.stdoutChunk ? String(progress.stdoutChunk).trim() : '';
  const stderrChunk = progress.stderrChunk ? String(progress.stderrChunk).trim() : '';
  const statusBits = [
    progress.statusStage ? `${stageEmoji(progress.statusStage)} Stage: ${progress.statusStage}` : null,
    progress.statusSummary ? `📝 Summary: ${previewText(progress.statusSummary, 220)}` : null,
    progress.statusHypothesis ? `💭 Hypothesis: ${previewText(progress.statusHypothesis, 220)}` : null,
    progress.statusEvidence ? `🔎 Evidence: ${previewText(progress.statusEvidence, 220)}` : null,
    progress.statusDecision ? `⚖️ Decision: ${previewText(progress.statusDecision, 220)}` : null,
    progress.statusNextStep ? `➡️ Next: ${previewText(progress.statusNextStep, 220)}` : null,
  ].filter(Boolean);

  const lines = [`${runnerStatusEmoji('running')} ${String(progress.runner)} live at ${elapsed}.`];
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
    lines.push('', '📤 Output:', stdoutChunk);
  } else if (stderrChunk) {
    lines.push('', '⚠️ stderr:', stderrChunk);
  }
  return lines.join('\n');
}

function runnerResultMessage(result: Record<string, unknown>, rootDir: string): string {
  const esc = escapeHtml;
  const lines = [
    `${runnerStatusEmoji(result.status)} <b>${esc(String(result.runner || ''))} ${esc(String(result.status || ''))} in ${formatDuration(Number(result.durationMs) || 0)}.</b>`,
  ];

  if (result.finalOutput) {
    lines.push('', String(result.finalOutput));
  } else if (result.summary) {
    lines.push('', esc(String(result.summary)));
  }

  if (!result.finalOutput && result.lastKnownStage) lines.push(`${stageEmoji(result.lastKnownStage)} <b>Last stage:</b> ${esc(String(result.lastKnownStage))}`);
  if (!result.finalOutput && result.lastKnownSummary) lines.push(`📝 <b>Last summary:</b> ${esc(String(result.lastKnownSummary))}`);
  if (!result.finalOutput && result.lastKnownHypothesis) lines.push(`💭 <b>Last hypothesis:</b> ${esc(String(result.lastKnownHypothesis))}`);
  if (!result.finalOutput && result.lastKnownEvidence) lines.push(`🔎 <b>Last evidence:</b> ${esc(String(result.lastKnownEvidence))}`);
  if (!result.finalOutput && result.lastKnownDecision) lines.push(`⚖️ <b>Last decision:</b> ${esc(String(result.lastKnownDecision))}`);
  if (!result.finalOutput && result.lastKnownNextStep) lines.push(`➡️ <b>Last next step:</b> ${esc(String(result.lastKnownNextStep))}`);

  if (result.branchName) lines.push('', `<b>Branch:</b> <code>${esc(String(result.branchName))}</code>`);
  if (result.commitSha) lines.push(`<b>Commit:</b> <code>${esc(String(result.commitSha))}</code>`);
  if (Array.isArray(result.changedFiles) && result.changedFiles.length > 0) {
    lines.push(`<b>Files:</b> <code>${esc(result.changedFiles.join(', '))}</code>`);
  }
  if (result.keptWorktreePath) {
    lines.push(`<b>Worktree kept:</b> <code>${esc(relativeDisplayPath(String(result.keptWorktreePath), rootDir))}</code>`);
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    lines.push(`⚠️ <b>Warnings:</b> ${esc(result.warnings.join(' | '))}`);
  }

  return lines.join('\n');
}

module.exports = {
  escapeHtml,
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
