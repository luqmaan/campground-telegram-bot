const fs = require('node:fs');
const path = require('node:path');

const config = require('./config.ts');
const {
  ensureDir,
  nowIso,
  previewText,
  readJson,
  sanitizeText,
  writeJson,
} = require('./utils.ts');

type RunnerName = 'claude' | 'codex';

type AuthorizedUser = {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  addedAt: string;
  source: string;
};

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

type ActiveTask = {
  id: string;
  runner: RunnerName;
  promptPreview: string | null;
  startedAt: string;
  pid: number | null;
  status: 'running';
  uploadCount: number;
  branchName: string | null;
  worktreePath?: string | null;
  commandSummary?: string | null;
  lastProgressAt?: string | null;
  changedFiles?: string[];
  changedFileCount?: number;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  statusStage?: string | null;
  statusSummary?: string | null;
  statusHypothesis?: string | null;
  statusEvidence?: string | null;
  statusDecision?: string | null;
  statusNextStep?: string | null;
  cardMessageId?: number | null;
  cardThreadId?: number | null;
  warnings: string[];
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
  lastKnownStage: string | null;
  lastKnownSummary: string | null;
  lastKnownHypothesis: string | null;
  lastKnownEvidence: string | null;
  lastKnownDecision: string | null;
  lastKnownNextStep: string | null;
  warnings: string[];
};

type TaskMessageRoute = {
  messageId: number;
  threadId: number | null;
  taskId: string;
  runner: RunnerName;
  kind: 'card';
  createdAt: string;
};

type SessionState = {
  chatId: string;
  history: Array<{ role: string; content: string; at: string }>;
  pendingUploads: UploadRecord[];
  activeTasks: ActiveTask[];
  activeTask: ActiveTask | null;
  lastResults: TaskResult[];
  lastRunner: RunnerName | null;
  lastResult: TaskResult | null;
  messageRoutes: TaskMessageRoute[];
  lastSeenMessageAt: string | null;
};

type AuthState = {
  users: Record<string, AuthorizedUser>;
  maxAuthorizedUsers: number;
};

class SessionStore {
  constructor() {
    ensureDir(config.DATA_DIR);
    ensureDir(config.SESSION_DIR);
    ensureDir(config.UPLOAD_DIR);
    ensureDir(config.PROMPT_DIR);
    ensureDir(config.TMP_DIR);
  }

  sessionFile(chatId: string | number): string {
    return path.join(config.SESSION_DIR, `${chatId}.json`);
  }

  listSessionIds(): string[] {
    ensureDir(config.SESSION_DIR);
    return fs
      .readdirSync(config.SESSION_DIR)
      .filter((name: string) => name.endsWith('.json'))
      .map((name: string) => name.replace(/\.json$/, ''));
  }

  defaultSession(chatId: string | number): SessionState {
    return {
      chatId: String(chatId),
      history: [],
      pendingUploads: [],
      activeTasks: [],
      activeTask: null,
      lastResults: [],
      lastRunner: null,
      lastResult: null,
      messageRoutes: [],
      lastSeenMessageAt: null,
    };
  }

  getSession(chatId: string | number): SessionState {
    const raw = readJson(this.sessionFile(chatId), this.defaultSession(chatId));
    const activeTasks = Array.isArray(raw.activeTasks) ? raw.activeTasks : raw.activeTask ? [raw.activeTask] : [];
    const lastResults = Array.isArray(raw.lastResults) ? raw.lastResults : raw.lastResult ? [raw.lastResult] : [];
    return {
      ...this.defaultSession(chatId),
      ...raw,
      history: Array.isArray(raw.history) ? raw.history.slice(-config.SESSION_HISTORY_LIMIT) : [],
      pendingUploads: Array.isArray(raw.pendingUploads) ? raw.pendingUploads : [],
      activeTasks,
      activeTask: activeTasks[activeTasks.length - 1] || null,
      lastResults,
      lastResult: lastResults[lastResults.length - 1] || null,
      messageRoutes: Array.isArray(raw.messageRoutes) ? raw.messageRoutes.slice(-100) : [],
    };
  }

  saveSession(chatId: string | number, session: SessionState): SessionState {
    const activeTasks = Array.isArray(session.activeTasks) ? session.activeTasks : session.activeTask ? [session.activeTask] : [];
    const lastResults = Array.isArray(session.lastResults) ? session.lastResults : session.lastResult ? [session.lastResult] : [];
    const next = {
      ...this.defaultSession(chatId),
      ...session,
      history: Array.isArray(session.history) ? session.history.slice(-config.SESSION_HISTORY_LIMIT) : [],
      pendingUploads: Array.isArray(session.pendingUploads) ? session.pendingUploads : [],
      activeTasks,
      activeTask: activeTasks[activeTasks.length - 1] || null,
      lastResults,
      lastResult: lastResults[lastResults.length - 1] || null,
      messageRoutes: Array.isArray(session.messageRoutes) ? session.messageRoutes.slice(-100) : [],
    };
    writeJson(this.sessionFile(chatId), next);
    return next;
  }

  updateSession(chatId: string | number, updater: (session: SessionState) => SessionState | void): SessionState {
    const session = this.getSession(chatId);
    const updated = updater(session) || session;
    return this.saveSession(chatId, updated);
  }

  touchChat(chatId: string | number): SessionState {
    return this.updateSession(chatId, (session) => {
      session.lastSeenMessageAt = nowIso();
      return session;
    });
  }

  addHistory(chatId: string | number, role: string, content: string): SessionState {
    const compact = sanitizeText(content);
    if (!compact) return this.getSession(chatId);
    return this.updateSession(chatId, (session) => {
      session.history.push({ role, content: compact, at: nowIso() });
      return session;
    });
  }

  clearHistory(chatId: string | number): SessionState {
    return this.updateSession(chatId, (session) => {
      session.history = [];
      return session;
    });
  }

  historyContext(chatId: string | number, maxChars = 6000): string {
    const joined = this.getSession(chatId)
      .history.map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
      .join('\n\n');
    if (joined.length <= maxChars) return joined;
    return joined.slice(joined.length - maxChars);
  }

  appendPendingUploads(chatId: string | number, uploads: UploadRecord[]): SessionState {
    if (!uploads.length) return this.getSession(chatId);
    return this.updateSession(chatId, (session) => {
      session.pendingUploads = [...session.pendingUploads, ...uploads];
      return session;
    });
  }

  peekPendingUploads(chatId: string | number): UploadRecord[] {
    return this.getSession(chatId).pendingUploads;
  }

  consumePendingUploads(chatId: string | number): UploadRecord[] {
    let uploads: UploadRecord[] = [];
    this.updateSession(chatId, (session) => {
      uploads = session.pendingUploads.slice();
      session.pendingUploads = [];
      return session;
    });
    return uploads;
  }

  getActiveTasks(chatId: string | number): ActiveTask[] {
    return this.getSession(chatId).activeTasks;
  }

  latestActiveTask(chatId: string | number): ActiveTask | null {
    return this.getSession(chatId).activeTasks.slice(-1)[0] || null;
  }

  getActiveTask(chatId: string | number, taskId: string): ActiveTask | null {
    return this.getSession(chatId).activeTasks.find((task) => String(task.id) === String(taskId)) || null;
  }

  addActiveTask(chatId: string | number, activeTask: ActiveTask): SessionState {
    return this.updateSession(chatId, (session) => {
      session.activeTasks = [...session.activeTasks.filter((task) => String(task.id) !== String(activeTask.id)), activeTask];
      session.activeTask = activeTask;
      if (activeTask) session.lastRunner = activeTask.runner;
      return session;
    });
  }

  setTaskPid(chatId: string | number, taskId: string, pid: number | null): SessionState {
    return this.updateSession(chatId, (session) => {
      session.activeTasks = session.activeTasks.map((task) =>
        String(task.id) === String(taskId)
          ? {
              ...task,
              pid,
            }
          : task
      );
      session.activeTask = session.activeTasks[session.activeTasks.length - 1] || null;
      return session;
    });
  }

  setTaskProgress(chatId: string | number, taskId: string, progress: Record<string, unknown>): SessionState {
    return this.updateSession(chatId, (session) => {
      session.activeTasks = session.activeTasks.map((task) => {
        if (String(task.id) !== String(taskId)) return task;
        const next = { ...task };
        next.lastProgressAt = nowIso();
        next.changedFiles = Array.isArray(progress.changedFiles) ? progress.changedFiles.map((value) => String(value)) : [];
        next.changedFileCount = Number(progress.changedFileCount) || next.changedFiles.length || 0;
        next.stdoutTail = progress.stdoutTail ? String(progress.stdoutTail) : null;
        next.stderrTail = progress.stderrTail ? String(progress.stderrTail) : null;
        if (progress.branchName) next.branchName = String(progress.branchName);
        if (progress.worktreePath !== undefined) next.worktreePath = progress.worktreePath ? String(progress.worktreePath) : null;
        if (progress.commandSummary) next.commandSummary = String(progress.commandSummary);
        next.statusStage = progress.statusStage ? String(progress.statusStage) : null;
        next.statusSummary = progress.statusSummary ? String(progress.statusSummary) : null;
        next.statusHypothesis = progress.statusHypothesis ? String(progress.statusHypothesis) : null;
        next.statusEvidence = progress.statusEvidence ? String(progress.statusEvidence) : null;
        next.statusDecision = progress.statusDecision ? String(progress.statusDecision) : null;
        next.statusNextStep = progress.statusNextStep ? String(progress.statusNextStep) : null;
        return next;
      });
      session.activeTask = session.activeTasks[session.activeTasks.length - 1] || null;
      return session;
    });
  }

  setTaskCard(chatId: string | number, taskId: string, card: { messageId: number | null; threadId?: number | null }): SessionState {
    return this.updateSession(chatId, (session) => {
      session.activeTasks = session.activeTasks.map((task) =>
        String(task.id) === String(taskId)
          ? {
              ...task,
              cardMessageId: card.messageId,
              cardThreadId: card.threadId ?? null,
            }
          : task
      );
      session.activeTask = session.activeTasks[session.activeTasks.length - 1] || null;
      if (card.messageId) {
        session.messageRoutes = [
          ...session.messageRoutes.filter((route) => route.messageId !== card.messageId),
          {
            messageId: card.messageId,
            threadId: card.threadId ?? null,
            taskId: String(taskId),
            runner: (session.activeTasks.find((task) => String(task.id) === String(taskId)) || session.activeTask || { runner: session.lastRunner || 'claude' }).runner,
            kind: 'card',
            createdAt: nowIso(),
          },
        ].slice(-100);
      }
      return session;
    });
  }

  completeTask(chatId: string | number, taskId: string, result: TaskResult): SessionState {
    return this.updateSession(chatId, (session) => {
      session.lastResults = [...session.lastResults.filter((entry) => String(entry.id) !== String(result.id)), result].slice(-20);
      session.lastResult = result;
      session.lastRunner = result.runner;
      session.activeTasks = session.activeTasks.filter((task) => String(task.id) !== String(taskId));
      session.activeTask = session.activeTasks[session.activeTasks.length - 1] || null;
      return session;
    });
  }

  findMessageRoute(chatId: string | number, messageId: number): TaskMessageRoute | null {
    return this.getSession(chatId).messageRoutes.find((route) => Number(route.messageId) === Number(messageId)) || null;
  }

  findResult(chatId: string | number, taskId: string): TaskResult | null {
    return this.getSession(chatId).lastResults.find((result) => String(result.id) === String(taskId)) || null;
  }

  reconcileInterruptedTasks(): Array<{
    chatId: string;
    runner: RunnerName;
    pid: number | null;
    cardMessageId: number | null;
    cardThreadId: number | null;
    activeTask: ActiveTask;
    result: TaskResult;
  }> {
    const repaired: Array<{
      chatId: string;
      runner: RunnerName;
      pid: number | null;
      cardMessageId: number | null;
      cardThreadId: number | null;
      activeTask: ActiveTask;
      result: TaskResult;
    }> = [];

    for (const chatId of this.listSessionIds()) {
      const session = this.getSession(chatId);
      if (!session.activeTasks.length) continue;

      const repairedForChat: typeof repaired = [];
      for (const activeTask of session.activeTasks) {
        const pid = Number(activeTask.pid) || null;
        if (pid) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }

        const startedAtMs = Date.parse(String(activeTask.startedAt || ''));
        const finishedAt = nowIso();
        const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
        const warnings = [...(Array.isArray(activeTask.warnings) ? activeTask.warnings : []), 'Task was interrupted because bilal69-bot restarted.'];

        const result: TaskResult = {
          id: String(activeTask.id || `interrupted-${Date.now()}`),
          runner: activeTask.runner,
          status: 'failed',
          summary: 'Interrupted because bilal69-bot restarted before the task finished.',
          finalOutput: null,
          startedAt: String(activeTask.startedAt || finishedAt),
          finishedAt,
          durationMs,
          stdoutTail: String(activeTask.stdoutTail || ''),
          stderrTail: String(activeTask.stderrTail || ''),
          branchName: activeTask.branchName || null,
          commitSha: null,
          changedFiles: Array.isArray(activeTask.changedFiles) ? activeTask.changedFiles.map((value) => String(value)) : [],
          keptWorktreePath: activeTask.worktreePath || null,
          lastKnownStage: activeTask.statusStage || null,
          lastKnownSummary: activeTask.statusSummary || null,
          lastKnownHypothesis: activeTask.statusHypothesis || null,
          lastKnownEvidence: activeTask.statusEvidence || null,
          lastKnownDecision: activeTask.statusDecision || null,
          lastKnownNextStep: activeTask.statusNextStep || null,
          warnings,
        };
        session.lastResults = [...session.lastResults.filter((entry) => String(entry.id) !== String(result.id)), result].slice(-20);
        repairedForChat.push({
          chatId,
          runner: activeTask.runner,
          pid,
          cardMessageId: activeTask.cardMessageId || null,
          cardThreadId: activeTask.cardThreadId || null,
          activeTask: { ...activeTask },
          result,
        });
      }

      if (repairedForChat.length > 0) {
        session.lastResult = session.lastResults[session.lastResults.length - 1] || null;
        session.lastRunner = repairedForChat[repairedForChat.length - 1].runner;
      }
      session.activeTasks = [];
      session.activeTask = null;
      this.saveSession(chatId, session);
      repaired.push(...repairedForChat);
    }

    return repaired;
  }

  defaultAuthState(): AuthState {
    return {
      users: {
        [String(config.OWNER_USER_ID)]: {
          id: String(config.OWNER_USER_ID),
          username: null,
          firstName: 'Owner',
          lastName: null,
          addedAt: nowIso(),
          source: 'seed',
        },
      },
      maxAuthorizedUsers: config.MAX_AUTH_USERS,
    };
  }

  loadAuthState(): AuthState {
    const raw = readJson(config.AUTH_STATE_FILE, this.defaultAuthState());
    const state = {
      ...this.defaultAuthState(),
      ...raw,
      users: raw.users || {},
      maxAuthorizedUsers: Number(raw.maxAuthorizedUsers) || config.MAX_AUTH_USERS,
    };
    if (!state.users[String(config.OWNER_USER_ID)]) {
      state.users[String(config.OWNER_USER_ID)] = this.defaultAuthState().users[String(config.OWNER_USER_ID)];
      this.saveAuthState(state);
    }
    return state;
  }

  saveAuthState(state: AuthState): void {
    writeJson(config.AUTH_STATE_FILE, state);
  }

  loadBotState(): { offset: number } {
    const raw = readJson(config.BOT_STATE_FILE, { offset: 0 });
    return {
      offset: Number(raw.offset) || 0,
    };
  }

  saveBotState(state: { offset: number }): void {
    writeJson(config.BOT_STATE_FILE, state);
  }

  ensureAuthorized(user: Record<string, unknown>): {
    authorized: boolean;
    user?: AuthorizedUser;
    newlyAdded?: boolean;
    reason?: string;
  } {
    const authState = this.loadAuthState();
    const userId = String(user?.id || '');
    if (!userId) {
      return { authorized: false, reason: 'missing-user' };
    }

    if (authState.users[userId]) {
      authState.users[userId] = {
        ...authState.users[userId],
        ...profileFromTelegramUser(user, authState.users[userId].source || 'telegram'),
      };
      this.saveAuthState(authState);
      return {
        authorized: true,
        user: authState.users[userId],
        newlyAdded: false,
      };
    }

    const currentCount = Object.keys(authState.users).length;
    if (!user.is_bot && currentCount < authState.maxAuthorizedUsers) {
      authState.users[userId] = profileFromTelegramUser(user, 'auto-discovered');
      this.saveAuthState(authState);
      return {
        authorized: true,
        user: authState.users[userId],
        newlyAdded: true,
      };
    }

    return { authorized: false, reason: 'not-authorized' };
  }

  listAuthorizedUsers(): { users: AuthorizedUser[]; maxAuthorizedUsers: number } {
    const state = this.loadAuthState();
    return {
      users: Object.values(state.users),
      maxAuthorizedUsers: state.maxAuthorizedUsers,
    };
  }
}

function profileFromTelegramUser(user: Record<string, unknown>, source = 'telegram'): AuthorizedUser {
  return {
    id: String(user.id),
    username: typeof user.username === 'string' ? user.username : null,
    firstName: typeof user.first_name === 'string' ? user.first_name : null,
    lastName: typeof user.last_name === 'string' ? user.last_name : null,
    addedAt: nowIso(),
    source,
  };
}

function displayName(profile: AuthorizedUser | null | undefined): string {
  if (!profile) return 'unknown';
  const parts = [profile.firstName, profile.lastName].filter(Boolean);
  const fullName = parts.join(' ').trim();
  if (fullName) {
    return profile.username ? `${fullName} (@${profile.username})` : fullName;
  }
  if (profile.username) return `@${profile.username}`;
  return String(profile.id);
}

function uploadSummary(uploads: UploadRecord[]): string {
  if (!uploads.length) return 'no uploads';
  return uploads
    .slice(0, 3)
    .map((upload) => previewText(upload.fileName, 40) || upload.kind)
    .join(', ');
}

module.exports = {
  SessionStore,
  displayName,
  profileFromTelegramUser,
  uploadSummary,
};
