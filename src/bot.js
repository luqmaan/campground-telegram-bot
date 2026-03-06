const fs = require('node:fs');
const { spawn } = require('node:child_process');

const config = require('./config');
const { CampgroundMonitor } = require('./monitor');

function ensureDataDir() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function log(level, message, data) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [bilal69-bot] [${level}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === 'string' ? data : JSON.stringify(data));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function previewText(value, limit = 160) {
  const compact = sanitizeText(value);
  if (!compact) return null;
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 3)}...`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatSince(epochMs) {
  if (!epochMs) return 'never';
  const diff = Date.now() - epochMs;
  return `${new Date(epochMs).toISOString()} (${formatDuration(diff)} ago)`;
}

async function sendTelegram(chatId, text, options = {}) {
  if (!text || !sanitizeText(text)) return;
  const threadId = options.threadId ?? null;
  const html = Boolean(options.html);
  let remaining = String(text);

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, 3800);
    remaining = remaining.slice(3800);

    const payload = {
      chat_id: Number(chatId),
      text: chunk,
    };
    if (threadId) payload.message_thread_id = threadId;
    if (html) payload.parse_mode = 'HTML';

    const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram API error: ${JSON.stringify(data).slice(0, 300)}`);
    }
  }
}

function defaultAuthState() {
  return {
    users: {
      [String(config.OWNER_USER_ID)]: {
        id: String(config.OWNER_USER_ID),
        username: null,
        firstName: 'Owner',
        lastName: null,
        addedAt: new Date().toISOString(),
        source: 'seed',
      },
    },
    maxAuthorizedUsers: config.MAX_AUTH_USERS,
  };
}

function loadAuthState() {
  const state = readJson(config.AUTH_STATE_FILE, defaultAuthState());
  if (!state.users[String(config.OWNER_USER_ID)]) {
    state.users[String(config.OWNER_USER_ID)] = defaultAuthState().users[String(config.OWNER_USER_ID)];
    writeJson(config.AUTH_STATE_FILE, state);
  }
  return state;
}

function saveAuthState(state) {
  writeJson(config.AUTH_STATE_FILE, state);
}

function loadHistory() {
  return readJson(config.HISTORY_FILE, []);
}

function saveHistory(history) {
  writeJson(config.HISTORY_FILE, history.slice(-12));
}

function addHistory(role, content) {
  const history = loadHistory();
  history.push({ role, content, at: new Date().toISOString() });
  saveHistory(history);
}

function clearHistory() {
  saveHistory([]);
}

function historyContext() {
  return loadHistory()
    .map((entry) => `${String(entry.role).toUpperCase()}: ${entry.content}`)
    .join('\n\n')
    .slice(0, 6000);
}

function loadBotState() {
  return readJson(config.BOT_STATE_FILE, { offset: 0 });
}

function saveBotState(state) {
  writeJson(config.BOT_STATE_FILE, state);
}

function profileFromUser(user, source = 'telegram') {
  return {
    id: String(user.id),
    username: user.username || null,
    firstName: user.first_name || null,
    lastName: user.last_name || null,
    addedAt: new Date().toISOString(),
    source,
  };
}

function displayName(profile) {
  if (!profile) return 'unknown';
  const parts = [profile.firstName, profile.lastName].filter(Boolean);
  const full = parts.join(' ').trim();
  if (full) return profile.username ? `${full} (@${profile.username})` : full;
  if (profile.username) return `@${profile.username}`;
  return String(profile.id);
}

function ensureAuthorized(msg) {
  const authState = loadAuthState();
  const userId = String(msg?.from?.id || '');
  if (!userId) {
    return { authorized: false, reason: 'missing-user' };
  }
  if (authState.users[userId]) {
    authState.users[userId] = { ...authState.users[userId], ...profileFromUser(msg.from, authState.users[userId].source || 'telegram') };
    saveAuthState(authState);
    return { authorized: true, user: authState.users[userId], newlyAdded: false };
  }

  const currentUsers = Object.keys(authState.users).length;
  if (!msg.from.is_bot && currentUsers < authState.maxAuthorizedUsers) {
    authState.users[userId] = profileFromUser(msg.from, 'auto-discovered');
    saveAuthState(authState);
    return { authorized: true, user: authState.users[userId], newlyAdded: true };
  }

  return { authorized: false, reason: 'not-authorized' };
}

function usersMessage() {
  const authState = loadAuthState();
  const users = Object.values(authState.users);
  const lines = [`Authorized users (${users.length}/${authState.maxAuthorizedUsers})`];
  users.forEach((user, index) => {
    lines.push(`${index + 1}. ${displayName(user)} [${user.id}] via ${user.source}`);
  });
  return lines.join('\n');
}

const monitor = new CampgroundMonitor(sendTelegram);
let claudeBusy = false;
let claudeChild = null;
let manualRunPromise = null;

function statusMessage() {
  const state = monitor.getStatus();
  const lines = [
    'Campground monitor status',
    `Scheduler: ${state.schedulerEnabled ? 'running' : 'paused'}`,
  ];

  if (state.activeRun) {
    lines.push(`Active run: ${state.activeRun.mode} since ${state.activeRun.startedAt}`);
  } else {
    lines.push(`Last check: ${formatSince(state.lastCheck)}`);
  }

  if (state.lastError) {
    lines.push(`Last error: ${state.lastError}`);
  }

  if (state.runs.length > 0) {
    lines.push('', 'Last 3 runs:');
    state.runs.forEach((run, index) => {
      lines.push(`${index + 1}. ${run.mode} ${run.success ? 'ok' : 'failed'} ${run.finishedAt} | alerts ${run.alertsSent}, openings ${run.facilitiesWithAvailability}, checks ${run.successfulChecks}/${run.checksAttempted}, ${formatDuration(run.durationMs)}`);
    });
  }

  return lines.join('\n');
}

function logsMessage() {
  const state = monitor.getStatus();
  if (!state.recentEvents.length) return 'No recent monitor events yet.';
  return ['Recent monitor events:', ...state.recentEvents].join('\n');
}

async function startManualRun(chatId, threadId) {
  if (manualRunPromise) {
    await sendTelegram(chatId, 'A manual run is already in progress.', { threadId });
    return;
  }

  await sendTelegram(chatId, 'Starting a manual campsite check now.', { threadId });
  manualRunPromise = monitor.runCheck('manual')
    .then(async (result) => {
      if (result.skipped) {
        await sendTelegram(chatId, 'Manual run skipped because another run is already active.', { threadId });
        return;
      }
      await sendTelegram(chatId, monitor.latestRunSummary(), { threadId });
    })
    .catch(async (error) => {
      await sendTelegram(chatId, `Manual run failed: ${error instanceof Error ? error.message : String(error)}`, { threadId });
    })
    .finally(() => {
      manualRunPromise = null;
    });
}

async function askClaude(question, msg) {
  if (claudeBusy) {
    await sendTelegram(msg.chat.id, 'Claude is already working on a task. Send "cancel claude" or wait for it to finish.', {
      threadId: msg.message_thread_id,
    });
    return;
  }

  claudeBusy = true;
  const sender = displayName(profileFromUser(msg.from));
  addHistory('user', `${sender}: ${question}`);
  await sendTelegram(msg.chat.id, 'Running that through Claude.', { threadId: msg.message_thread_id });

  const promptFile = `${config.DATA_DIR}/claude-prompt-${Date.now()}.txt`;
  const prompt = `You are a campground-monitor control assistant running inside ${config.ROOT_DIR}.

Relevant files:
- src/bot.js
- src/monitor.js
- src/monitor-config.js

Scope rules:
1. Stay focused on the campground monitor bot and its monitoring logic.
2. Keep replies concise and Telegram-friendly.
3. If you take an action, state the outcome first.

Current status:
${statusMessage()}

Recent conversation:
${historyContext()}

Incoming message from ${sender}:
${question}
`;

  fs.writeFileSync(promptFile, prompt);

  claudeChild = spawn('bash', [
    '-lc',
    `cat "${promptFile}" | timeout ${config.CLAUDE_TIMEOUT_SECONDS} claude -p --model sonnet --dangerously-skip-permissions 2>&1`,
  ], {
    cwd: config.ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  claudeChild.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  claudeChild.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  claudeChild.on('close', async (code, signal) => {
    claudeBusy = false;
    claudeChild = null;
    try { fs.rmSync(promptFile, { force: true }); } catch {}

    if (signal === 'SIGTERM' || code === 124) {
      await sendTelegram(msg.chat.id, 'Claude timed out after 5 minutes.', { threadId: msg.message_thread_id });
      return;
    }
    if (code !== 0) {
      await sendTelegram(msg.chat.id, `Claude failed: ${stripAnsi(stderr || stdout).slice(-1200) || `exit ${code}`}`, {
        threadId: msg.message_thread_id,
      });
      return;
    }

    const response = stripAnsi(stdout).trim().slice(-3500) || 'Claude finished with no output.';
    addHistory('assistant', response);
    await sendTelegram(msg.chat.id, response, { threadId: msg.message_thread_id });
  });

  claudeChild.on('error', async (error) => {
    claudeBusy = false;
    claudeChild = null;
    await sendTelegram(msg.chat.id, `Failed to start Claude: ${error.message}`, { threadId: msg.message_thread_id });
  });
}

async function handleCommand(msg) {
  const text = sanitizeText(msg.text || msg.caption || '');
  const lower = text.toLowerCase();
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;

  if (!text) {
    await sendTelegram(chatId, 'Send a text command. Try "help" or "status".', { threadId });
    return;
  }

  if (/^(\/start(@\w+)?|help|\?|actions?)$/i.test(lower)) {
    await sendTelegram(
      chatId,
      [
        'Campground bot commands:',
        'status',
        'run now',
        'pause monitor',
        'resume monitor',
        'restart monitor',
        'logs',
        'users',
        'forget',
        'cancel claude',
        '',
        'Anything else is sent to Claude.',
      ].join('\n'),
      { threadId }
    );
    return;
  }

  if (/^(status|health|overview)$/i.test(lower)) {
    await sendTelegram(chatId, statusMessage(), { threadId });
    return;
  }

  if (/^(users|who|authorized)$/i.test(lower)) {
    await sendTelegram(chatId, usersMessage(), { threadId });
    return;
  }

  if (/^(run|run now|check|check now)$/i.test(lower)) {
    await startManualRun(chatId, threadId);
    return;
  }

  if (/^(pause|pause monitor|stop monitor)$/i.test(lower)) {
    monitor.pauseScheduler();
    await sendTelegram(chatId, 'Monitor scheduler paused.', { threadId });
    return;
  }

  if (/^(resume|resume monitor|start monitor)$/i.test(lower)) {
    await monitor.resumeScheduler();
    await sendTelegram(chatId, 'Monitor scheduler running.', { threadId });
    return;
  }

  if (/^(restart|restart monitor)$/i.test(lower)) {
    await monitor.restartScheduler();
    await sendTelegram(chatId, 'Monitor scheduler restarted.', { threadId });
    return;
  }

  if (/^logs?$/i.test(lower)) {
    await sendTelegram(chatId, logsMessage(), { threadId });
    return;
  }

  if (/^(forget|clear|reset)$/i.test(lower)) {
    clearHistory();
    await sendTelegram(chatId, 'Claude history cleared.', { threadId });
    return;
  }

  if (/^cancel\s*claude$/i.test(lower)) {
    if (!claudeBusy || !claudeChild) {
      await sendTelegram(chatId, 'No Claude task is running.', { threadId });
      return;
    }
    try {
      claudeChild.kill('SIGTERM');
      await sendTelegram(chatId, 'Claude task cancelled.', { threadId });
    } catch (error) {
      await sendTelegram(chatId, `Failed to cancel Claude: ${error instanceof Error ? error.message : String(error)}`, { threadId });
    }
    return;
  }

  await askClaude(text, msg);
}

async function handleMessage(msg) {
  if (!msg?.chat?.id || String(msg.chat.id) !== String(config.GROUP_CHAT_ID)) {
    return;
  }
  if (!msg?.from?.id) {
    return;
  }

  const summary = {
    chatId: msg.chat.id,
    fromId: msg.from.id,
    fromUsername: msg.from.username || null,
    text: previewText(msg.text || msg.caption),
  };
  log('INFO', 'Incoming message', summary);

  const auth = ensureAuthorized(msg);
  if (!auth.authorized) {
    await sendTelegram(msg.chat.id, 'Not authorized for campground control.', { threadId: msg.message_thread_id });
    return;
  }

  if (auth.newlyAdded) {
    await sendTelegram(msg.chat.id, `Authorized ${displayName(auth.user)} for campground control.`, {
      threadId: msg.message_thread_id,
    });
  }

  await handleCommand(msg);
}

async function pollLoop() {
  const botState = loadBotState();
  let offset = botState.offset || 0;

  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/getUpdates?offset=${offset}&timeout=${config.POLL_TIMEOUT_SECONDS}`, {
        signal: AbortSignal.timeout((config.POLL_TIMEOUT_SECONDS + 5) * 1000),
      });
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.result)) {
        log('WARN', 'Invalid poll response', data);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        saveBotState({ offset });
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

async function main() {
  ensureDataDir();
  log('INFO', 'Starting bilal69 bot');
  log('INFO', `Group chat: ${config.GROUP_CHAT_ID}`);
  log('INFO', `Owner user: ${config.OWNER_USER_ID}`);
  await monitor.startScheduler();
  await pollLoop();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error) => {
  log('ERROR', 'Fatal error', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
