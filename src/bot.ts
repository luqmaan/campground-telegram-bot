const config = require('./config.ts');
const { CampgroundMonitor } = require('./monitor.ts');
const { SessionStore, displayName, profileFromTelegramUser } = require('./session-store.ts');
const {
  helpMessage,
  logsMessage,
  manualRunProgressMessage,
  manualRunStartedMessage,
  parseCommand,
  runnerProgressMessage,
  runnerResultMessage,
  runnerStartedMessage,
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

    const response = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data).slice(0, 300)}`);
    }
  }
}

const monitor = new CampgroundMonitor(sendTelegram);
const runningTasks = new Map<string, Record<string, unknown>>();
let manualRunPromise: Promise<void> | null = null;

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

async function startManualRun(chatId: string | number, threadId: number | null | undefined): Promise<void> {
  if (manualRunPromise) {
    await sendTelegram(chatId, 'A manual run is already in progress.', { threadId });
    return;
  }

  const scope = monitor.scopeSummary();
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
  const historyEntry = uploads.length > 0 ? `${prompt}\nAttachments: ${uploads.map((upload) => upload.fileName).join(', ')}` : prompt;
  sessionStore.addHistory(chatId, 'user', `${sender}: ${historyEntry}`);

  const startTask = input.runner === 'codex' ? startCodexTask : startClaudeTask;
  const handle = startTask({
    prompt,
    uploads,
    historyContext: sessionStore.historyContext(chatId),
    statusContext: currentStatusMessage(chatId),
    senderName: sender,
    onProgress: async (progress: Record<string, unknown>) => {
      await sendTelegram(chatId, runnerProgressMessage(progress), { threadId: input.threadId });
    },
  });

  sessionStore.setActiveTask(chatId, handle.meta);
  runningTasks.set(chatId, handle);
  await sendTelegram(chatId, runnerStartedMessage(handle.meta), { threadId: input.threadId });

  handle.promise
    .then(async (result: Record<string, unknown>) => {
      runningTasks.delete(chatId);
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
      runningTasks.delete(chatId);
      sessionStore.setActiveTask(chatId, null);
      await sendTelegram(chatId, `${input.runner} failed before completion: ${error.message}`, { threadId: input.threadId });
    });

  if (handle.getPid()) {
    sessionStore.setTaskPid(chatId, handle.getPid());
  }
}

async function handleRunnerCommand(input: {
  command: Record<string, unknown>;
  message: TelegramMessage;
  uploads: Array<Record<string, unknown>>;
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
  });
}

async function handleCommand(message: TelegramMessage, uploads: Array<Record<string, unknown>>): Promise<void> {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id;
  const text = sanitizeText(message.text || message.caption || '');
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
    text: previewText(message.text || message.caption),
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

  log('INFO', 'Starting bilal69 bot');
  log('INFO', `Group chat: ${config.GROUP_CHAT_ID}`);
  log('INFO', `Owner user: ${config.OWNER_USER_ID}`);
  log('INFO', `Node version: ${process.version}`);
  await monitor.startScheduler();
  await pollLoop();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error: Error) => {
  log('ERROR', 'Fatal error', error.stack || error.message);
  process.exit(1);
});
