const config = require('./config.ts');
const { PARK_INFO } = require('./monitor-config.ts');
const { CampgroundMonitor } = require('./monitor.ts');
const { SessionStore, displayName, profileFromTelegramUser } = require('./session-store.ts');
const {
  helpMessage,
  logsMessage,
  manualRunProgressMessage,
  manualRunStartedMessage,
  parseCommand,
  runnerCardMessage,
  runnerResultMessage,
  statusMessage,
  uploadQueuedMessage,
  usersMessage,
} = require('./commands.ts');
const { extractMessageUploads, uploadsPromptBlock } = require('./media.ts');
const { applyRef, deployStatusMessage, repoSummary, scheduleDeploy, shouldDeployFiles } = require('./repo-actions.ts');
const { startClaudeTask } = require('./runner-claude.ts');
const { startCodexTask } = require('./runner-codex.ts');
const { appendTaskSteer } = require('./runner-common.ts');
const { ensureDir, nowIso, previewText, sanitizeText } = require('./utils.ts');

type TelegramMessage = {
  message_id: number;
  chat: { id: number | string; type?: string; title?: string };
  from?: Record<string, unknown>;
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: Record<string, unknown>;
  video?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  message_thread_id?: number;
  reply_to_message?: {
    message_id?: number;
    from?: Record<string, unknown>;
    text?: string;
    caption?: string;
    photo?: unknown[];
    document?: Record<string, unknown>;
    video?: Record<string, unknown>;
    audio?: Record<string, unknown>;
    voice?: Record<string, unknown>;
  };
};

type TelegramCallbackQuery = {
  id: string;
  from?: Record<string, unknown>;
  data?: string;
  message?: {
    message_id: number;
    chat: { id: number | string };
    message_thread_id?: number;
  };
};

const sessionStore = new SessionStore();

function log(level: string, message: string, data?: unknown): void {
  const prefix = `[${nowIso()}] [bilal69-bot] [${level}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === 'string' ? data : JSON.stringify(data));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

async function telegramApi(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function sendTelegram(chatId: string | number, text: string, options: { threadId?: number | null; html?: boolean } = {}): Promise<void> {
  if (!text || !sanitizeText(text)) return;
  const threadId = options.threadId ?? null;
  const html = Boolean(options.html);
  let remaining = String(text);

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, 3800);
    remaining = remaining.slice(3800);
    const payload: Record<string, unknown> = {
      chat_id: Number(chatId),
      text: chunk,
      disable_web_page_preview: true,
    };
    if (threadId) payload.message_thread_id = threadId;
    if (html) payload.parse_mode = 'HTML';
    await telegramApi('sendMessage', payload);
  }
}

async function sendTelegramSingle(
  chatId: string | number,
  text: string,
  options: { threadId?: number | null; html?: boolean; replyMarkup?: Record<string, unknown> | null } = {}
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    chat_id: Number(chatId),
    text: String(text).slice(0, 3800),
    disable_web_page_preview: true,
  };
  if (options.threadId) payload.message_thread_id = options.threadId;
  if (options.html) payload.parse_mode = 'HTML';
  if (options.replyMarkup) payload.reply_markup = options.replyMarkup;
  const data = await telegramApi('sendMessage', payload);
  return data.result || {};
}

async function editTelegramSingle(
  chatId: string | number,
  messageId: number,
  text: string,
  options: { html?: boolean; replyMarkup?: Record<string, unknown> | null } = {}
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: Number(chatId),
    message_id: Number(messageId),
    text: String(text).slice(0, 3800),
    disable_web_page_preview: true,
  };
  if (options.html) payload.parse_mode = 'HTML';
  if (options.replyMarkup) payload.reply_markup = options.replyMarkup;
  try {
    await telegramApi('editMessageText', payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/message is not modified/i.test(message)) return;
    throw error;
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const payload: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };
  if (text) payload.text = text;
  await telegramApi('answerCallbackQuery', payload);
}

async function sendChatAction(
  chatId: string | number,
  action: 'typing' | 'upload_document',
  options: { threadId?: number | null } = {}
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: Number(chatId),
    action,
  };
  if (options.threadId) payload.message_thread_id = options.threadId;
  await telegramApi('sendChatAction', payload);
}

function startChatActionPulse(
  chatId: string | number,
  options: { threadId?: number | null; action?: 'typing' | 'upload_document'; intervalMs?: number } = {}
): () => void {
  const action = options.action || 'typing';
  const intervalMs = options.intervalMs || 4000;
  let stopped = false;

  const pulse = async (): Promise<void> => {
    if (stopped) return;
    try {
      await sendChatAction(chatId, action, { threadId: options.threadId });
    } catch (error) {
      log('WARN', 'Failed to send Telegram chat action', error instanceof Error ? error.message : String(error));
    }
  };

  void pulse();
  const timer = setInterval(() => {
    void pulse();
  }, intervalMs);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

const monitor = new CampgroundMonitor(sendTelegram);
const runningTasks = new Map<string, Record<string, unknown>>();
const runnerProgressState = new Map<string, { lastEventId: number }>();
let manualRunPromise: Promise<void> | null = null;

function runnerTaskKeyboard(running: boolean): Record<string, unknown> {
  return {
    inline_keyboard: [
      running
        ? [
            { text: 'Status', callback_data: 'runner:status' },
            { text: 'Logs', callback_data: 'runner:logs' },
            { text: 'Cancel', callback_data: 'runner:cancel' },
          ]
        : [
            { text: 'Status', callback_data: 'runner:status' },
            { text: 'Logs', callback_data: 'runner:logs' },
          ],
    ],
  };
}

function messageBodyText(message?: TelegramMessage | Record<string, unknown> | null): string {
  if (!message) return '';
  return sanitizeText((message as TelegramMessage).text || (message as TelegramMessage).caption || '');
}

function explicitRunnerInText(rawText: string): 'claude' | 'codex' | null {
  const text = sanitizeText(rawText);
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/^\/claude(?:@[\w_]+)?(?:\s|$)/.test(lower) || /^claude(?:\s|$)/.test(lower)) return 'claude';
  if (/^\/codex(?:@[\w_]+)?(?:\s|$)/.test(lower) || /^codex(?:\s|$)/.test(lower)) return 'codex';
  return null;
}

function replyTaskRoute(chatId: string | number, message?: TelegramMessage | null): Record<string, unknown> | null {
  const replyMessageId = Number(message?.reply_to_message?.message_id || 0);
  if (!replyMessageId) return null;
  return sessionStore.findMessageRoute(chatId, replyMessageId);
}

function replyContextText(message?: TelegramMessage | null): string | null {
  const reply = message?.reply_to_message;
  if (!reply) return null;

  const sender = displayName(profileFromTelegramUser(reply.from || {})) || 'Unknown sender';
  const body = previewText(messageBodyText(reply), 600);
  const attachmentKinds: string[] = [];
  if (Array.isArray(reply.photo) && reply.photo.length > 0) attachmentKinds.push('photo');
  if (reply.document) attachmentKinds.push('document');
  if (reply.video) attachmentKinds.push('video');
  if (reply.audio) attachmentKinds.push('audio');
  if (reply.voice) attachmentKinds.push('voice');

  const lines = [`Replying to ${sender} (message ${reply.message_id || '?'})`];
  if (body) {
    lines.push(`Text: ${body}`);
  }
  if (attachmentKinds.length > 0) {
    lines.push(`Attachments: ${attachmentKinds.join(', ')}`);
  }
  return lines.join('\n');
}

function taskHandle(taskId: string | number | null | undefined): Record<string, unknown> | undefined {
  if (!taskId) return undefined;
  return runningTasks.get(String(taskId));
}

function latestActiveTaskHandle(chatId: string | number): Record<string, unknown> | undefined {
  const latestTask = sessionStore.latestActiveTask(chatId);
  return latestTask ? taskHandle(String(latestTask.id)) : undefined;
}

function taskWorkspacePath(activeTask?: Record<string, unknown> | null): string {
  if (activeTask?.worktreePath) {
    return String(activeTask.worktreePath);
  }
  return config.ROOT_DIR;
}

function interactiveSteerText(input: {
  sender: string;
  prompt: string;
  replyContext: string | null;
  uploads: Array<Record<string, unknown>>;
}): string {
  const prompt =
    sanitizeText(input.prompt) || (input.uploads.length > 0 ? 'Review the attached files and adjust your work accordingly.' : '');
  const parts = [`Telegram steer from ${input.sender}.`];
  if (input.replyContext) {
    parts.push('Reply context:', input.replyContext);
  }
  if (input.uploads.length > 0) {
    parts.push('Attached local files:', uploadsPromptBlock(input.uploads, config.ROOT_DIR));
  }
  if (prompt) {
    parts.push(`Latest Telegram message from ${input.sender}:`, prompt);
  }
  return parts.join('\n\n');
}

function sessionSnapshot(chatId: string | number, taskId: string | null = null): Record<string, unknown> {
  const session = sessionStore.getSession(chatId);
  return {
    ...session,
    activeTask: taskId ? sessionStore.getActiveTask(chatId, taskId) : session.activeTask,
    lastResult: taskId ? sessionStore.findResult(chatId, taskId) : session.lastResult,
    repoStatus: repoSummary(),
    deployStatus: deployStatusMessage(),
  };
}

function currentStatusMessage(chatId: string | number, taskId: string | null = null): string {
  return statusMessage({
    monitorStatus: monitor.getStatus(),
    session: sessionSnapshot(chatId, taskId),
    manualRunActive: Boolean(manualRunPromise),
  });
}

function hasBlockingActivity(): boolean {
  return runningTasks.size > 0 || Boolean(manualRunPromise);
}

function shouldSendRunnerProgress(taskId: string, progress: Record<string, unknown>): boolean {
  const state = runnerProgressState.get(taskId) || { lastEventId: 0 };
  const eventId = Number(progress.eventId) || 0;
  if (!eventId || eventId <= state.lastEventId) {
    return false;
  }
  state.lastEventId = eventId;
  runnerProgressState.set(taskId, state);
  return true;
}

async function upsertRunnerTaskCard(input: {
  chatId: string;
  threadId: number | null | undefined;
  activeTask: Record<string, unknown> | null;
  progress?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}): Promise<void> {
  if (!input.activeTask) return;

  const { card, overflow } = runnerCardMessage({
    status: input.result ? input.result.status : 'running',
    runner: input.activeTask.runner,
    promptPreview: input.activeTask.promptPreview,
    elapsedMs: input.progress?.elapsedMs || (input.result ? input.result.durationMs : Date.now() - Date.parse(String(input.activeTask.startedAt || nowIso()))),
    durationMs: input.result?.durationMs || 0,
    heartbeat: input.progress?.heartbeat || false,
    idleMs: input.progress?.idleMs || 0,
    statusStage: input.result?.lastKnownStage || input.activeTask.statusStage || input.progress?.statusStage || null,
    statusSummary: input.result?.lastKnownSummary || input.activeTask.statusSummary || input.progress?.statusSummary || null,
    statusHypothesis: input.result?.lastKnownHypothesis || input.activeTask.statusHypothesis || input.progress?.statusHypothesis || null,
    statusEvidence: input.result?.lastKnownEvidence || input.activeTask.statusEvidence || input.progress?.statusEvidence || null,
    statusDecision: input.result?.lastKnownDecision || input.activeTask.statusDecision || input.progress?.statusDecision || null,
    statusNextStep: input.result?.lastKnownNextStep || input.activeTask.statusNextStep || input.progress?.statusNextStep || null,
    changedFiles: input.result?.changedFiles || input.activeTask.changedFiles || input.progress?.changedFiles || [],
    changedFileCount:
      (Array.isArray(input.result?.changedFiles) ? input.result.changedFiles.length : 0) ||
      input.activeTask.changedFileCount ||
      input.progress?.changedFileCount ||
      0,
    stdoutChunk: input.progress?.stdoutChunk || '',
    stdoutTail: input.result?.stdoutTail || input.progress?.stdoutTail || input.activeTask.stdoutTail || '',
    stderrChunk: input.progress?.stderrChunk || '',
    stderrTail: input.result?.stderrTail || input.progress?.stderrTail || input.activeTask.stderrTail || '',
    summary: input.result?.summary || null,
    finalOutput: input.result?.finalOutput || null,
    commitSha: input.result?.commitSha || null,
    postActions: input.result?.postActions || [],
    warnings: input.result?.warnings || input.activeTask.warnings || [],
  });

  if (input.activeTask.cardMessageId) {
    await editTelegramSingle(input.chatId, Number(input.activeTask.cardMessageId), card, {
      replyMarkup: runnerTaskKeyboard(!input.result),
      html: true,
    });
    if (overflow) {
      await sendTelegram(input.chatId, overflow, { threadId: input.threadId });
    }
    return;
  }

  const sent = await sendTelegramSingle(input.chatId, card, {
    threadId: input.threadId,
    replyMarkup: runnerTaskKeyboard(true),
    html: true,
  });
  if (overflow) {
    await sendTelegram(input.chatId, overflow, { threadId: input.threadId });
  }
  sessionStore.setTaskCard(input.chatId, String(input.activeTask.id), {
    messageId: Number(sent.message_id) || null,
    threadId: input.threadId ?? null,
  });
}

async function startManualRun(chatId: string | number, threadId: number | null | undefined): Promise<void> {
  if (manualRunPromise) {
    await sendTelegram(chatId, 'A manual run is already in progress.', { threadId });
    return;
  }

  const scope = monitor.scopeSummary();
  const stopChatAction = startChatActionPulse(chatId, { threadId });
  let lastProgressMessage = '';
  const sendManualProgress = async (): Promise<void> => {
    const activeRun = monitor.getStatus().activeRun;
    if (!activeRun || activeRun.mode !== 'manual') {
      return;
    }
    const message = manualRunProgressMessage(activeRun);
    if (message === lastProgressMessage) {
      return;
    }
    lastProgressMessage = message;
    try {
      await sendTelegram(chatId, message, { threadId });
    } catch (error) {
      log('WARN', 'Failed to send manual progress update', error instanceof Error ? error.message : String(error));
    }
  };

  await sendTelegram(chatId, manualRunStartedMessage(scope), { threadId });
  const progressInterval = setInterval(() => {
    void sendManualProgress();
  }, 12000);

  manualRunPromise = monitor
    .runCheck('manual')
    .then(async (result: Record<string, unknown>) => {
      if (result.skipped) {
        await sendTelegram(chatId, 'Manual run skipped because another run is already active.', { threadId });
        return;
      }
      await sendTelegram(chatId, monitor.latestRunSummary(), { threadId });
    })
    .catch(async (error: Error) => {
      await sendTelegram(chatId, `Manual run failed: ${error.message}`, { threadId });
    })
    .finally(() => {
      clearInterval(progressInterval);
      stopChatAction();
      manualRunPromise = null;
    });
}

async function startRunnerForMessage(input: {
  chatId: string | number;
  threadId: number | null | undefined;
  runner: 'claude' | 'codex';
  prompt: string;
  resumeSessionId?: string | null;
  message: TelegramMessage;
  immediateUploads: Array<Record<string, unknown>>;
  replyContext: string | null;
}): Promise<void> {
  const chatId = String(input.chatId);
  const pendingUploads = sessionStore.consumePendingUploads(chatId);
  const uploads = [...pendingUploads, ...input.immediateUploads];
  const prompt = sanitizeText(input.prompt) || (uploads.length > 0 ? 'Review the attached files and tell me what matters.' : '');

  if (!prompt) {
    if (uploads.length > 0) {
      sessionStore.appendPendingUploads(chatId, uploads);
    }
    await sendTelegram(chatId, 'Send a task after /claude or /codex. Uploads were kept pending if any were attached.', {
      threadId: input.threadId,
    });
    return;
  }

  const sender = displayName(profileFromTelegramUser(input.message.from || {}));
  const historyParts = [prompt];
  if (input.replyContext) {
    historyParts.push(input.replyContext);
  }
  if (uploads.length > 0) {
    historyParts.push(`Attachments: ${uploads.map((upload) => upload.fileName).join(', ')}`);
  }
  const historyEntry = historyParts.join('\n');
  sessionStore.addHistory(chatId, 'user', `${sender}: ${historyEntry}`);

  const startTask = input.runner === 'codex' ? startCodexTask : startClaudeTask;
  const stopChatAction = startChatActionPulse(chatId, { threadId: input.threadId });
  const handle = startTask({
    prompt,
    replyContext: input.replyContext,
    uploads,
    historyContext: sessionStore.historyContext(chatId),
    statusContext: currentStatusMessage(chatId),
    senderName: sender,
    resumeSessionId: input.resumeSessionId || null,
    onProgress: async (progress: Record<string, unknown>) => {
      const progressTaskId = String(progress.taskId || handle.meta.id);
      sessionStore.setTaskProgress(chatId, progressTaskId, progress);
      if (!shouldSendRunnerProgress(progressTaskId, progress)) {
        return;
      }
      const activeTask = sessionStore.getActiveTask(chatId, progressTaskId);
      if (!activeTask) return;
      await upsertRunnerTaskCard({
        chatId,
        threadId: input.threadId,
        activeTask,
        progress,
      });
    },
  });

  const taskId = String(handle.meta.id);
  sessionStore.addActiveTask(chatId, handle.meta);
  runningTasks.set(taskId, handle);
  runnerProgressState.set(taskId, { lastEventId: 0 });
  await upsertRunnerTaskCard({
    chatId,
    threadId: input.threadId,
    activeTask: handle.meta,
  });

  handle.promise
    .then(async (result: Record<string, unknown>) => {
      const finishedTaskId = String(result.id || taskId);
      const activeTask = sessionStore.getActiveTask(chatId, finishedTaskId) || handle.meta;
      runningTasks.delete(finishedTaskId);
      runnerProgressState.delete(finishedTaskId);
      const followups: string[] = [];
      if (result.status === 'completed' && result.commitSha) {
        try {
          const applyResult = applyRef(String(result.commitSha), result);
          followups.push(String(applyResult.message));
          if (!applyResult.noop && shouldDeployFiles(Array.isArray(result.changedFiles) ? result.changedFiles : [])) {
            const deployResult = scheduleDeploy(`${sender} via ${input.runner}`, String(result.commitSha));
            followups.push(String(deployResult.message));
          } else if (Array.isArray(result.changedFiles) && result.changedFiles.length > 0) {
            followups.push('No deploy was needed because the changes do not affect the live runtime.');
          }
        } catch (error) {
          followups.push(`Auto-apply failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (result.status === 'completed' && Array.isArray(result.changedFiles) && result.changedFiles.length > 0 && !result.commitSha) {
        followups.push('Changes were produced but not auto-applied because no task commit was created.');
      }

      const cardResult = followups.length > 0 ? { ...result, postActions: followups } : result;
      try {
        await upsertRunnerTaskCard({
          chatId,
          threadId: input.threadId,
          activeTask,
          result: cardResult,
        });
      } catch (error) {
        log('WARN', 'Failed to update runner task card', error instanceof Error ? error.message : String(error));
      }
      sessionStore.completeTask(chatId, finishedTaskId, result);
      if (result.finalOutput) {
        sessionStore.addHistory(chatId, 'assistant', String(result.finalOutput));
      }
    })
    .catch(async (error: Error) => {
      const failedTaskId = String(handle.meta.id);
      const activeTask = sessionStore.getActiveTask(chatId, failedTaskId) || handle.meta;
      runningTasks.delete(failedTaskId);
      runnerProgressState.delete(failedTaskId);
      const failedResult = {
        id: failedTaskId,
        runner: input.runner,
        sessionId: activeTask.sessionId || null,
        status: 'failed',
        summary: error.message,
        finalOutput: null,
        startedAt: String(activeTask.startedAt || nowIso()),
        finishedAt: nowIso(),
        durationMs: Math.max(0, Date.now() - Date.parse(String(activeTask.startedAt || nowIso()))),
        stdoutTail: String(activeTask.stdoutTail || ''),
        stderrTail: String(activeTask.stderrTail || ''),
        branchName: activeTask.branchName || null,
        commitSha: null,
        changedFiles: Array.isArray(activeTask.changedFiles) ? activeTask.changedFiles : [],
        keptWorktreePath: activeTask.worktreePath || null,
        lastKnownStage: activeTask.statusStage || null,
        lastKnownSummary: activeTask.statusSummary || null,
        lastKnownHypothesis: activeTask.statusHypothesis || null,
        lastKnownEvidence: activeTask.statusEvidence || null,
        lastKnownDecision: activeTask.statusDecision || null,
        lastKnownNextStep: activeTask.statusNextStep || null,
        warnings: Array.isArray(activeTask.warnings) ? activeTask.warnings : [],
      };
      if (activeTask) {
        try {
          await upsertRunnerTaskCard({
            chatId,
            threadId: input.threadId,
            activeTask,
            result: failedResult,
          });
        } catch (cardError) {
          log('WARN', 'Failed to update runner task card', cardError instanceof Error ? cardError.message : String(cardError));
        }
      }
      sessionStore.completeTask(chatId, failedTaskId, failedResult);
    })
    .finally(() => {
      runnerProgressState.delete(String(handle.meta.id));
      stopChatAction();
    });

  if (handle.getPid()) {
    sessionStore.setTaskPid(chatId, taskId, handle.getPid());
  }
}

async function reconcileInterruptedTaskCards(
  repairedTasks: Array<{
    chatId: string;
    runner: string;
    pid: number | null;
    cardMessageId: number | null;
    cardThreadId: number | null;
    activeTask: Record<string, unknown>;
    result: Record<string, unknown>;
  }>
): Promise<void> {
  for (const repaired of repairedTasks) {
    try {
      const { card } = runnerCardMessage({
        status: repaired.result.status,
        runner: repaired.activeTask.runner,
        promptPreview: repaired.activeTask.promptPreview,
        durationMs: repaired.result.durationMs || 0,
        statusStage: repaired.result.lastKnownStage || repaired.activeTask.statusStage || null,
        statusSummary: repaired.result.lastKnownSummary || repaired.activeTask.statusSummary || null,
        statusHypothesis: repaired.result.lastKnownHypothesis || repaired.activeTask.statusHypothesis || null,
        statusEvidence: repaired.result.lastKnownEvidence || repaired.activeTask.statusEvidence || null,
        statusDecision: repaired.result.lastKnownDecision || repaired.activeTask.statusDecision || null,
        statusNextStep: repaired.result.lastKnownNextStep || repaired.activeTask.statusNextStep || null,
        changedFiles: repaired.result.changedFiles || repaired.activeTask.changedFiles || [],
        changedFileCount:
          (Array.isArray(repaired.result.changedFiles) ? repaired.result.changedFiles.length : 0) ||
          repaired.activeTask.changedFileCount ||
          0,
        summary: repaired.result.summary || null,
        stdoutChunk: '',
        stdoutTail: repaired.result.stdoutTail || repaired.activeTask.stdoutTail || '',
        stderrChunk: '',
        stderrTail: repaired.result.stderrTail || repaired.activeTask.stderrTail || '',
        commitSha: repaired.result.commitSha || null,
        warnings: repaired.result.warnings || repaired.activeTask.warnings || [],
      });

      if (repaired.cardMessageId) {
        await editTelegramSingle(repaired.chatId, repaired.cardMessageId, card, {
          replyMarkup: runnerTaskKeyboard(false),
          html: true,
        });
      } else {
        await sendTelegram(repaired.chatId, runnerResultMessage(repaired.result, config.ROOT_DIR), {
          threadId: repaired.cardThreadId ?? null,
        });
      }
    } catch (error) {
      log('WARN', 'Failed to reconcile interrupted task card', error instanceof Error ? error.message : String(error));
    }
  }
}

async function handleRunnerCommand(input: {
  command: Record<string, unknown>;
  message: TelegramMessage;
  uploads: Array<Record<string, unknown>>;
  replyContext: string | null;
  resumeSessionId?: string | null;
}): Promise<void> {
  const chatId = input.message.chat.id;
  const threadId = input.message.message_thread_id;
  await startRunnerForMessage({
    chatId,
    threadId,
    runner: input.command.runner,
    prompt: String(input.command.prompt || ''),
    resumeSessionId: input.resumeSessionId || null,
    message: input.message,
    immediateUploads: input.uploads,
    replyContext: input.replyContext,
  });
}

async function steerRunnerTask(input: {
  chatId: string | number;
  threadId: number | null | undefined;
  taskId: string;
  activeTask: Record<string, unknown>;
  message: TelegramMessage;
  command: Record<string, unknown>;
  replyContext: string | null;
  uploads: Array<Record<string, unknown>>;
}): Promise<void> {
  const sender = displayName(profileFromTelegramUser(input.message.from || {}));
  const steerText = input.command.type === 'runner' ? sanitizeText(input.command.prompt || '') : '';
  if (!steerText && input.uploads.length === 0) {
    await sendTelegram(input.chatId, 'Send text or attach files to steer that running agent.', { threadId: input.threadId });
    return;
  }

  const liveTask = taskHandle(input.taskId) || null;
  const directSteerText = interactiveSteerText({
    sender,
    prompt: steerText,
    replyContext: input.replyContext,
    uploads: input.uploads,
  });

  if (input.activeTask.runner === 'claude' && liveTask && typeof liveTask.steer === 'function') {
    try {
      const ok = Boolean(liveTask.steer(directSteerText));
      if (!ok) {
        throw new Error('Claude stdin is no longer accepting steer messages.');
      }
    } catch (error) {
      await sendTelegram(
        input.chatId,
        `Failed to steer running Claude task: ${error instanceof Error ? error.message : String(error)}`,
        { threadId: input.threadId }
      );
      return;
    }
  } else {
    try {
      appendTaskSteer({
        cwd: taskWorkspacePath(input.activeTask),
        senderName: sender,
        text: steerText,
        uploads: input.uploads,
        at: nowIso(),
      });
    } catch (error) {
      await sendTelegram(
        input.chatId,
        `Failed to steer running ${String(input.activeTask.runner || 'agent')} task: ${error instanceof Error ? error.message : String(error)}`,
        { threadId: input.threadId }
      );
      return;
    }
  }

  const historyParts = [];
  if (steerText) {
    historyParts.push(steerText);
  }
  if (input.uploads.length > 0) {
    historyParts.push(`Steer attachments: ${input.uploads.map((upload) => upload.fileName || upload.kind).join(', ')}`);
  }
  sessionStore.addHistory(input.chatId, 'user', `${sender}: [steer ${input.taskId}] ${historyParts.join('\n')}`);

  const lines = [`Steer sent to running ${String(input.activeTask.runner || 'agent')} task.`];
  if (steerText) {
    lines.push(`Text: ${previewText(steerText, 160)}`);
  }
  if (input.uploads.length > 0) {
    lines.push(`Attachments: ${input.uploads.length}`);
  }
  lines.push(
    input.activeTask.runner === 'claude' && liveTask && typeof liveTask.steer === 'function'
      ? 'It was injected into the live Claude session for this run.'
      : 'It will pick this up from the live steer inbox during the current run.'
  );
  await sendTelegram(input.chatId, lines.join('\n'), { threadId: input.threadId });
}

async function handleCommand(message: TelegramMessage, uploads: Array<Record<string, unknown>>): Promise<void> {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id;
  const text = messageBodyText(message);
  const replyContext = replyContextText(message);
  const route = replyTaskRoute(chatId, message);
  const parsedCommand = parseCommand(text);
  const command =
    parsedCommand.type === 'runner' && route && !explicitRunnerInText(text)
      ? { ...parsedCommand, runner: route.runner }
      : parsedCommand;
  const sessionBefore = sessionStore.getSession(chatId);
  const selectedTaskId = route ? String(route.taskId) : null;
  const selectedActiveTask = selectedTaskId ? sessionStore.getActiveTask(chatId, selectedTaskId) : null;
  const selectedResult = selectedTaskId ? sessionStore.findResult(chatId, selectedTaskId) : null;
  const selectedTaskIsRunning = Boolean(selectedTaskId && selectedActiveTask && taskHandle(selectedTaskId));
  const resumeSessionId =
    !selectedTaskIsRunning && command.type === 'runner' && command.runner === 'claude' && selectedResult?.sessionId
      ? String(selectedResult.sessionId)
      : null;

  if (selectedTaskIsRunning && (command.type === 'runner' || (command.type === 'empty' && uploads.length > 0))) {
    await steerRunnerTask({
      chatId,
      threadId,
      taskId: selectedTaskId,
      activeTask: selectedActiveTask,
      message,
      command,
      replyContext,
      uploads,
    });
    return;
  }

  if (command.type === 'empty') {
    if (uploads.length > 0) {
      const session = sessionStore.appendPendingUploads(chatId, uploads);
      await sendTelegram(chatId, uploadQueuedMessage(uploads, session.pendingUploads.length), { threadId });
      return;
    }
    await sendTelegram(chatId, 'Send a command or a task. Try /help.', { threadId });
    return;
  }

  if (command.type !== 'runner' && uploads.length > 0) {
    const session = sessionStore.appendPendingUploads(chatId, uploads);
    await sendTelegram(chatId, uploadQueuedMessage(uploads, session.pendingUploads.length), { threadId });
  }

  if (command.type === 'help') {
    await sendTelegram(chatId, helpMessage(), { threadId });
    return;
  }

  if (command.type === 'status') {
    await sendTelegram(chatId, currentStatusMessage(chatId, selectedTaskId), { threadId });
    return;
  }

  if (command.type === 'scope') {
    await sendTelegram(chatId, monitor.scopeMessage(), { threadId });
    return;
  }

  if (command.type === 'users') {
    const auth = sessionStore.listAuthorizedUsers();
    await sendTelegram(chatId, usersMessage(auth.users, auth.maxAuthorizedUsers), { threadId });
    return;
  }

  if (command.type === 'run-monitor') {
    await startManualRun(chatId, threadId);
    return;
  }

  if (command.type === 'pause-monitor') {
    monitor.pauseScheduler();
    await sendTelegram(chatId, 'Monitor scheduler paused.', { threadId });
    return;
  }

  if (command.type === 'resume-monitor') {
    await monitor.resumeScheduler();
    await sendTelegram(chatId, 'Monitor scheduler running.', { threadId });
    return;
  }

  if (command.type === 'restart-monitor') {
    try {
      const requestedBy = displayName(profileFromTelegramUser(message.from || {}));
      const result = scheduleDeploy(requestedBy, null);
      await sendTelegram(chatId, `Restarting bot process... ${result.message}`, { threadId });
    } catch (error) {
      await sendTelegram(chatId, `Restart failed: ${error instanceof Error ? error.message : String(error)}`, { threadId });
    }
    return;
  }

  if (command.type === 'logs') {
    await sendTelegram(
      chatId,
      logsMessage({
        scope: String(command.scope || 'all'),
        monitorStatus: monitor.getStatus(),
        session: sessionSnapshot(chatId, selectedTaskId),
      }),
      { threadId }
    );
    return;
  }

  if (command.type === 'forget') {
    sessionStore.clearHistory(chatId);
    await sendTelegram(chatId, 'Chat history cleared for this group. Pending uploads were left intact.', { threadId });
    return;
  }

  if (command.type === 'cancel') {
    const targetTask = selectedTaskId ? taskHandle(selectedTaskId) : latestActiveTaskHandle(chatId);
    const task = targetTask || null;
    if (!task) {
      await sendTelegram(chatId, selectedTaskId ? 'That agent is not running anymore.' : 'No Claude or Codex task is running.', { threadId });
      return;
    }
    task.cancel();
    await sendTelegram(chatId, 'Task cancellation requested for that agent.', { threadId });
    return;
  }

  if (command.type === 'apply') {
    if (hasBlockingActivity()) {
      await sendTelegram(chatId, 'Cannot /apply while a runner task or manual monitor run is active.', { threadId });
      return;
    }
    try {
      const result = applyRef(String(command.ref || ''), sessionSnapshot(chatId, selectedTaskId).lastResult || null);
      await sendTelegram(chatId, String(result.message), { threadId });
    } catch (error) {
      await sendTelegram(chatId, `Apply failed: ${error instanceof Error ? error.message : String(error)}`, { threadId });
    }
    return;
  }

  if (command.type === 'deploy') {
    if (hasBlockingActivity()) {
      await sendTelegram(chatId, 'Cannot /deploy while a runner task or manual monitor run is active.', { threadId });
      return;
    }
    try {
      const requestedBy = displayName(profileFromTelegramUser(message.from || {}));
      const result = scheduleDeploy(requestedBy, sessionSnapshot(chatId, selectedTaskId).lastResult?.commitSha || null);
      await sendTelegram(chatId, String(result.message), { threadId });
    } catch (error) {
      await sendTelegram(chatId, `Deploy scheduling failed: ${error instanceof Error ? error.message : String(error)}`, { threadId });
    }
    return;
  }

  if (command.type === 'runner') {
    await handleRunnerCommand({
      command,
      message,
      uploads,
      replyContext,
      resumeSessionId,
    });
    return;
  }

  if (sessionBefore.pendingUploads.length > 0 && uploads.length === 0) {
    await sendTelegram(chatId, 'Pending uploads are waiting for the next /claude or /codex task.', { threadId });
  }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!message?.chat?.id || String(message.chat.id) !== String(config.GROUP_CHAT_ID)) {
    return;
  }
  if (!message?.from?.id) {
    return;
  }

  sessionStore.touchChat(message.chat.id);

  const summary = {
    chatId: message.chat.id,
    chatType: message.chat.type || null,
    chatTitle: message.chat.title || null,
    fromId: message.from.id,
    fromUsername: message.from.username || null,
    text: previewText(messageBodyText(message)),
    replyToMessageId: message.reply_to_message?.message_id || null,
    replyToText: previewText(messageBodyText(message.reply_to_message as TelegramMessage)),
    hasPhoto: Array.isArray(message.photo) && message.photo.length > 0,
    hasDocument: Boolean(message.document),
    hasVideo: Boolean(message.video),
    hasAudio: Boolean(message.audio),
    hasVoice: Boolean(message.voice),
  };
  log('INFO', 'Incoming message', summary);

  const auth = sessionStore.ensureAuthorized(message.from);
  if (!auth.authorized) {
    await sendTelegram(message.chat.id, 'Not authorized for campground control.', { threadId: message.message_thread_id });
    return;
  }

  if (auth.newlyAdded && auth.user) {
    await sendTelegram(message.chat.id, `Authorized ${displayName(auth.user)} for campground control.`, {
      threadId: message.message_thread_id,
    });
  }

  let uploads: Array<Record<string, unknown>> = [];
  try {
    uploads = await extractMessageUploads(message);
  } catch (error) {
    await sendTelegram(
      message.chat.id,
      `Failed to download Telegram attachment: ${error instanceof Error ? error.message : String(error)}`,
      { threadId: message.message_thread_id }
    );
    return;
  }

  await handleCommand(message, uploads);
}

async function handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId || String(chatId) !== String(config.GROUP_CHAT_ID)) {
    if (callbackQuery.id) await answerCallbackQuery(callbackQuery.id);
    return;
  }

  const threadId = callbackQuery.message?.message_thread_id;
  const action = String(callbackQuery.data || '');
  const route =
    callbackQuery.message?.message_id ? sessionStore.findMessageRoute(chatId, Number(callbackQuery.message.message_id)) : null;
  const selectedTaskId = route ? String(route.taskId) : null;
  const auth = sessionStore.ensureAuthorized(callbackQuery.from || {});
  if (!auth.authorized) {
    await answerCallbackQuery(callbackQuery.id, 'Not authorized.');
    return;
  }

  if (action === 'runner:status') {
    await answerCallbackQuery(callbackQuery.id, 'Sending status');
    await sendTelegram(chatId, currentStatusMessage(chatId, selectedTaskId), { threadId });
    return;
  }

  if (action === 'runner:logs') {
    await answerCallbackQuery(callbackQuery.id, 'Sending runner logs');
    await sendTelegram(
      chatId,
      logsMessage({
        scope: 'runner',
        monitorStatus: monitor.getStatus(),
        session: sessionSnapshot(chatId, selectedTaskId),
      }),
      { threadId }
    );
    return;
  }

  if (action === 'runner:cancel') {
    const task = selectedTaskId ? taskHandle(selectedTaskId) : latestActiveTaskHandle(chatId);
    if (!task) {
      await answerCallbackQuery(callbackQuery.id, 'No active task');
      return;
    }
    task.cancel();
    await answerCallbackQuery(callbackQuery.id, 'Cancelling task');
    await sendTelegram(chatId, 'Task cancellation requested for that agent.', { threadId });
    return;
  }

  await answerCallbackQuery(callbackQuery.id);
}

async function pollLoop(): Promise<void> {
  let offset = sessionStore.loadBotState().offset || 0;

  while (true) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${config.BOT_TOKEN}/getUpdates?offset=${offset}&timeout=${config.POLL_TIMEOUT_SECONDS}`,
        {
          signal: AbortSignal.timeout((config.POLL_TIMEOUT_SECONDS + 5) * 1000),
        }
      );
      const data = await response.json();
      if (!data.ok || !Array.isArray(data.result)) {
        log('WARN', 'Invalid poll response', data);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        sessionStore.saveBotState({ offset });
        if (update.message) {
          await handleMessage(update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
    } catch (error) {
      log('WARN', 'Poll error', error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

function msUntilDailySummary(hour = 20): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function scheduleDailySummary(): void {
  const delay = msUntilDailySummary(20);
  const h = Math.floor(delay / 3600000);
  const m = Math.floor((delay % 3600000) / 60000);
  log('INFO', `Daily summary scheduled in ${h}h ${m}m`);
  setTimeout(async () => {
    try {
      const message = monitor.getDailySummaryMessage();
      await sendTelegram(config.GROUP_CHAT_ID, message, { html: true });
    } catch (error) {
      log('WARN', 'Failed to send daily summary', error instanceof Error ? error.message : String(error));
    }
    scheduleDailySummary();
  }, delay);
}

// 8am release check state (tracks what we've already alerted on for the current day)
const releaseCheckFoundToday = new Set<string>();
let releaseCheckDay = '';

async function runReleaseCheckAttempt(attemptNumber: number, totalAttempts: number): Promise<void> {
  const today = monitor.localDateString();
  if (releaseCheckDay !== today) {
    releaseCheckFoundToday.clear();
    releaseCheckDay = today;
  }

  log('INFO', `8am release check attempt ${attemptNumber}/${totalAttempts}`);
  let result: Awaited<ReturnType<typeof monitor.runReleaseCheck>> | null = null;
  try {
    result = await monitor.runReleaseCheck();
  } catch (error) {
    log('WARN', '8am release check failed', error instanceof Error ? error.message : String(error));
    const errMsg = `⚠️ 8am release check attempt ${attemptNumber} failed: ${error instanceof Error ? error.message : String(error)}`;
    await sendTelegram(config.GROUP_CHAT_ID, errMsg).catch(() => {});
    return;
  }

  // Find newly discovered openings
  const newFindings: string[] = [];
  for (const r of result.results) {
    const key = `${r.target.facilityId}:${result.releaseDateIso}`;
    if (!releaseCheckFoundToday.has(key)) {
      releaseCheckFoundToday.add(key);
      const tier = Number(r.target.tier);
      const tierEmoji = tier === 1 ? '🔥' : tier === 2 ? '⭐' : '📍';
      const tierText = tier === 1 ? 'Tier 1 — High demand' : tier === 2 ? 'Tier 2 — Great pick' : 'Tier 3 — Good option';
      const parkInfo = (PARK_INFO as Record<string, { parkId: number; description: string }>)[String(r.target.parkName)];
      const bookingUrl = parkInfo
        ? `https://www.reservecalifornia.com/#/park/${parkInfo.parkId}/${r.target.facilityId}`
        : 'https://www.reservecalifornia.com';
      const description = parkInfo?.description ?? '';
      const siteList = r.sites.length > 0
        ? r.sites.map((s: { name: unknown; rate: unknown }) => `  Site ${s.name}${s.rate ? ` — $${s.rate}/night` : ''}`).join('\n')
        : '';
      newFindings.push(
        `${tierEmoji} <b>${r.target.parkName}</b> — ${r.target.facilityName} | ${tierText}\n` +
        (description ? `<i>${description}</i>\n` : '') +
        `<b>${r.available} site(s)</b> available on ${result.releaseDateLabel}\n` +
        siteList + '\n' +
        `🔗 <a href="${bookingUrl}">Book on ReserveCalifornia</a>`,
      );
    }
  }

  const isFirst = attemptNumber === 1;
  const isFinal = attemptNumber >= totalAttempts;

  // Build message
  let msg = '';
  if (isFirst) {
    msg += `🌅 <b>8am Release Check — ${result.releaseDateLabel}</b>\n`;
    msg += `Attempt ${attemptNumber}/${totalAttempts}  |  ${result.results.length > 0 || newFindings.length > 0 ? '🔔' : '✅'} `;
    if (newFindings.length > 0) {
      msg += `<b>${newFindings.length} facility/facilities with openings!</b>`;
    } else {
      msg += `No sites available yet.${isFinal ? '' : ' Retrying...'}`;
    }
  } else if (newFindings.length > 0) {
    msg += `🔔 <b>8am Release — New sites on attempt ${attemptNumber}!</b>\n`;
    msg += `(${result.releaseDateLabel})`;
  } else if (isFinal) {
    const totalFound = releaseCheckFoundToday.size;
    msg += `📊 <b>8am Release Check Done — ${result.releaseDateLabel}</b>\n`;
    msg += `${attemptNumber} attempts completed.\n`;
    msg += totalFound > 0
      ? `🔔 Found openings at ${totalFound} facility/facilities today.`
      : `✅ No new sites released for this date.`;
  }

  if (newFindings.length > 0) {
    msg += '\n\n' + newFindings.join('\n\n');
  }
  if (result.errors.length > 0 && (isFirst || isFinal)) {
    msg += `\n\n⚠️ ${result.errors.length} check error(s): ${result.errors[0]}`;
  }

  if (msg.trim()) {
    await sendTelegram(config.GROUP_CHAT_ID, msg, { html: true }).catch((err: Error) => {
      log('WARN', 'Failed to send release check message', err.message);
    });
  }

  // If final attempt AND something was found, auto-trigger Claude to analyze & update monitor-config
  if (isFinal && releaseCheckFoundToday.size > 0) {
    const summaryLines = [`8am release check completed. ${releaseCheckFoundToday.size} facilities have openings for ${result.releaseDateLabel}.`];
    for (const r of result.results) {
      summaryLines.push(`- ${r.target.parkName} / ${r.target.facilityName}: ${r.available} site(s)`);
    }
    const autoPrompt = summaryLines.join('\n') + '\n\nReview these findings. If the release date is worth monitoring (weekends, holidays, or popular dates), add it to DATE_RANGES in monitor-config.ts. Output a brief summary of what you found and what you did.';
    try {
      await startRunnerForMessage({
        chatId: config.GROUP_CHAT_ID,
        threadId: null,
        runner: 'claude',
        prompt: autoPrompt,
        resumeSessionId: null,
        message: { message_id: 0, chat: { id: config.GROUP_CHAT_ID } } as TelegramMessage,
        immediateUploads: [],
        replyContext: null,
      });
    } catch (err) {
      log('WARN', 'Failed to auto-trigger Claude after release check', err instanceof Error ? err.message : String(err));
    }
  }
}

// Retry schedule (ms after each attempt): 8:00, 8:05, 8:10, 8:20, 8:30
const RELEASE_CHECK_RETRY_DELAYS_MS = [5 * 60_000, 5 * 60_000, 10 * 60_000, 10 * 60_000];

function scheduleReleaseCheckRetries(attemptNumber: number, totalAttempts: number): void {
  if (attemptNumber >= totalAttempts) return;
  const delay = RELEASE_CHECK_RETRY_DELAYS_MS[attemptNumber - 1] ?? 10 * 60_000;
  setTimeout(() => {
    runReleaseCheckAttempt(attemptNumber + 1, totalAttempts)
      .then(() => scheduleReleaseCheckRetries(attemptNumber + 1, totalAttempts))
      .catch((err: Error) => log('WARN', 'Release check retry error', err.message));
  }, delay);
}

function schedule8amReleaseCheck(): void {
  const delay = msUntilDailySummary(8);
  const h = Math.floor(delay / 3600000);
  const m = Math.floor((delay % 3600000) / 60000);
  log('INFO', `8am release check scheduled in ${h}h ${m}m`);
  setTimeout(() => {
    const totalAttempts = 5; // 8:00, 8:05, 8:10, 8:20, 8:30
    runReleaseCheckAttempt(1, totalAttempts)
      .then(() => scheduleReleaseCheckRetries(1, totalAttempts))
      .catch((err: Error) => log('WARN', '8am release check error', err.message));
    schedule8amReleaseCheck(); // Schedule next day
  }, delay);
}

async function main(): Promise<void> {
  ensureDir(config.DATA_DIR);
  ensureDir(config.LOG_DIR);
  ensureDir(config.SESSION_DIR);
  ensureDir(config.UPLOAD_DIR);
  ensureDir(config.PROMPT_DIR);
  ensureDir(config.TMP_DIR);

  const repairedTasks = sessionStore.reconcileInterruptedTasks();
  log('INFO', 'Starting bilal69 bot');
  log('INFO', `Group chat: ${config.GROUP_CHAT_ID}`);
  log('INFO', `Owner user: ${config.OWNER_USER_ID}`);
  log('INFO', `Node version: ${process.version}`);
  if (repairedTasks.length > 0) {
    log('WARN', 'Reconciled interrupted runner tasks', repairedTasks);
    await reconcileInterruptedTaskCards(repairedTasks);
  }
  await monitor.startScheduler();
  scheduleDailySummary();
  schedule8amReleaseCheck();
  await pollLoop();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error: Error) => {
  log('ERROR', 'Fatal error', error.stack || error.message);
  process.exit(1);
});
