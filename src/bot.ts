const config = require('./config.ts');
const { CampgroundMonitor } = require('./monitor.ts');
const { SessionStore, displayName, profileFromTelegramUser } = require('./session-store.ts');
const {
  helpMessage,
  logsMessage,
  manualRunProgressMessage,
  manualRunStartedMessage,
  parseCommand,
  runnerCardMessage,
  runnerProgressMessage,
  runnerResultMessage,
  statusMessage,
  uploadQueuedMessage,
  usersMessage,
} = require('./commands.ts');
const { extractMessageUploads } = require('./media.ts');
const { applyRef, deployStatusMessage, repoSummary, scheduleDeploy, shouldDeployFiles } = require('./repo-actions.ts');
const { startClaudeTask } = require('./runner-claude.ts');
const { startCodexTask } = require('./runner-codex.ts');
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

function activeTaskHandle(chatId: string | number): Record<string, unknown> | undefined {
  return runningTasks.get(String(chatId));
}

function currentStatusMessage(chatId: string | number): string {
  return statusMessage({
    monitorStatus: monitor.getStatus(),
    session: {
      ...sessionStore.getSession(chatId),
      repoStatus: repoSummary(),
      deployStatus: deployStatusMessage(),
    },
    manualRunActive: Boolean(manualRunPromise),
  });
}

function hasBlockingActivity(): boolean {
  return runningTasks.size > 0 || Boolean(manualRunPromise);
}

function shouldSendRunnerProgress(chatId: string, progress: Record<string, unknown>): boolean {
  const state = runnerProgressState.get(chatId) || { lastEventId: 0 };
  const eventId = Number(progress.eventId) || 0;
  if (!eventId || eventId <= state.lastEventId) {
    return false;
  }
  state.lastEventId = eventId;
  runnerProgressState.set(chatId, state);
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

  const text = runnerCardMessage({
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
    stderrChunk: input.progress?.stderrChunk || '',
    summary: input.result?.summary || null,
    commitSha: input.result?.commitSha || null,
    warnings: input.result?.warnings || input.activeTask.warnings || [],
  });

  if (input.activeTask.cardMessageId) {
    await editTelegramSingle(input.chatId, Number(input.activeTask.cardMessageId), text, {
      replyMarkup: runnerTaskKeyboard(!input.result),
    });
    return;
  }

  const sent = await sendTelegramSingle(input.chatId, text, {
    threadId: input.threadId,
    replyMarkup: runnerTaskKeyboard(true),
  });
  sessionStore.setTaskCard(input.chatId, {
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
  message: TelegramMessage;
  immediateUploads: Array<Record<string, unknown>>;
  replyContext: string | null;
}): Promise<void> {
  const chatId = String(input.chatId);
  if (activeTaskHandle(chatId)) {
    await sendTelegram(chatId, 'A task is already running in this chat. Send /cancel or wait for it to finish.', {
      threadId: input.threadId,
    });
    return;
  }

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
  runnerProgressState.set(chatId, { lastEventId: 0 });
  const handle = startTask({
    prompt,
    replyContext: input.replyContext,
    uploads,
    historyContext: sessionStore.historyContext(chatId),
    statusContext: currentStatusMessage(chatId),
    senderName: sender,
    onProgress: async (progress: Record<string, unknown>) => {
      sessionStore.setTaskProgress(chatId, progress);
      if (!shouldSendRunnerProgress(chatId, progress)) {
        return;
      }
      const activeTask = sessionStore.getSession(chatId).activeTask;
      await upsertRunnerTaskCard({
        chatId,
        threadId: input.threadId,
        activeTask,
        progress,
      });
    },
  });

  sessionStore.setActiveTask(chatId, handle.meta);
  runningTasks.set(chatId, handle);
  await upsertRunnerTaskCard({
    chatId,
    threadId: input.threadId,
    activeTask: handle.meta,
  });

  handle.promise
    .then(async (result: Record<string, unknown>) => {
      const activeTask = sessionStore.getSession(chatId).activeTask;
      runningTasks.delete(chatId);
      runnerProgressState.delete(chatId);
      try {
        await upsertRunnerTaskCard({
          chatId,
          threadId: input.threadId,
          activeTask,
          result,
        });
      } catch (error) {
        log('WARN', 'Failed to update runner task card', error instanceof Error ? error.message : String(error));
      }
      sessionStore.setLastResult(chatId, result);
      if (result.finalOutput) {
        sessionStore.addHistory(chatId, 'assistant', String(result.finalOutput));
      }

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

      const resultMessage = runnerResultMessage(result, config.ROOT_DIR);
      const fullMessage = followups.length > 0 ? `${resultMessage}\n\n${followups.join('\n')}` : resultMessage;
      await sendTelegram(chatId, fullMessage, { threadId: input.threadId });
    })
    .catch(async (error: Error) => {
      const activeTask = sessionStore.getSession(chatId).activeTask;
      runningTasks.delete(chatId);
      runnerProgressState.delete(chatId);
      if (activeTask) {
        try {
          await upsertRunnerTaskCard({
            chatId,
            threadId: input.threadId,
            activeTask,
            result: {
              status: 'failed',
              durationMs: Date.now() - Date.parse(String(activeTask.startedAt || nowIso())),
              summary: error.message,
              warnings: activeTask.warnings || [],
            },
          });
        } catch (cardError) {
          log('WARN', 'Failed to update runner task card', cardError instanceof Error ? cardError.message : String(cardError));
        }
      }
      sessionStore.setActiveTask(chatId, null);
      await sendTelegram(chatId, `${input.runner} failed before completion: ${error.message}`, { threadId: input.threadId });
    })
    .finally(() => {
      runnerProgressState.delete(chatId);
      stopChatAction();
    });

  if (handle.getPid()) {
    sessionStore.setTaskPid(chatId, handle.getPid());
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
      const text = runnerCardMessage({
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
        stderrChunk: '',
        commitSha: repaired.result.commitSha || null,
        warnings: repaired.result.warnings || repaired.activeTask.warnings || [],
      });

      if (repaired.cardMessageId) {
        await editTelegramSingle(repaired.chatId, repaired.cardMessageId, text, {
          replyMarkup: runnerTaskKeyboard(false),
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
}): Promise<void> {
  const chatId = input.message.chat.id;
  const threadId = input.message.message_thread_id;
  await startRunnerForMessage({
    chatId,
    threadId,
    runner: input.command.runner,
    prompt: String(input.command.prompt || ''),
    message: input.message,
    immediateUploads: input.uploads,
    replyContext: input.replyContext,
  });
}

async function handleCommand(message: TelegramMessage, uploads: Array<Record<string, unknown>>): Promise<void> {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id;
  const text = messageBodyText(message);
  const replyContext = replyContextText(message);
  const command = parseCommand(text);
  const sessionBefore = sessionStore.getSession(chatId);

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
    await sendTelegram(chatId, currentStatusMessage(chatId), { threadId });
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
    await monitor.restartScheduler();
    await sendTelegram(chatId, 'Monitor scheduler restarted.', { threadId });
    return;
  }

  if (command.type === 'logs') {
    await sendTelegram(
      chatId,
      logsMessage({
        scope: String(command.scope || 'all'),
        monitorStatus: monitor.getStatus(),
        session: sessionStore.getSession(chatId),
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
    const task = activeTaskHandle(chatId);
    if (!task) {
      await sendTelegram(chatId, 'No Claude or Codex task is running.', { threadId });
      return;
    }
    task.cancel();
    await sendTelegram(chatId, 'Task cancellation requested.', { threadId });
    return;
  }

  if (command.type === 'apply') {
    if (hasBlockingActivity()) {
      await sendTelegram(chatId, 'Cannot /apply while a runner task or manual monitor run is active.', { threadId });
      return;
    }
    try {
      const result = applyRef(String(command.ref || ''), sessionStore.getSession(chatId).lastResult || null);
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
      const result = scheduleDeploy(requestedBy, sessionStore.getSession(chatId).lastResult?.commitSha || null);
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
  const auth = sessionStore.ensureAuthorized(callbackQuery.from || {});
  if (!auth.authorized) {
    await answerCallbackQuery(callbackQuery.id, 'Not authorized.');
    return;
  }

  if (action === 'runner:status') {
    await answerCallbackQuery(callbackQuery.id, 'Sending status');
    await sendTelegram(chatId, currentStatusMessage(chatId), { threadId });
    return;
  }

  if (action === 'runner:logs') {
    await answerCallbackQuery(callbackQuery.id, 'Sending runner logs');
    await sendTelegram(
      chatId,
      logsMessage({
        scope: 'runner',
        monitorStatus: monitor.getStatus(),
        session: sessionStore.getSession(chatId),
      }),
      { threadId }
    );
    return;
  }

  if (action === 'runner:cancel') {
    const task = activeTaskHandle(chatId);
    if (!task) {
      await answerCallbackQuery(callbackQuery.id, 'No active task');
      return;
    }
    task.cancel();
    await answerCallbackQuery(callbackQuery.id, 'Cancelling task');
    await sendTelegram(chatId, 'Task cancellation requested.', { threadId });
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
  await pollLoop();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error: Error) => {
  log('ERROR', 'Fatal error', error.stack || error.message);
  process.exit(1);
});
