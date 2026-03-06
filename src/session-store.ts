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
  warnings: string[];
};

type SessionState = {
  chatId: string;
  history: Array<{ role: string; content: string; at: string }>;
  pendingUploads: UploadRecord[];
  activeTask: ActiveTask | null;
  lastRunner: RunnerName | null;
  lastResult: TaskResult | null;
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

  defaultSession(chatId: string | number): SessionState {
    return {
      chatId: String(chatId),
      history: [],
      pendingUploads: [],
      activeTask: null,
      lastRunner: null,
      lastResult: null,
      lastSeenMessageAt: null,
    };
  }

  getSession(chatId: string | number): SessionState {
    const raw = readJson(this.sessionFile(chatId), this.defaultSession(chatId));
    return {
      ...this.defaultSession(chatId),
      ...raw,
      history: Array.isArray(raw.history) ? raw.history.slice(-config.SESSION_HISTORY_LIMIT) : [],
      pendingUploads: Array.isArray(raw.pendingUploads) ? raw.pendingUploads : [],
      activeTask: raw.activeTask || null,
      lastResult: raw.lastResult || null,
    };
  }

  saveSession(chatId: string | number, session: SessionState): SessionState {
    const next = {
      ...this.defaultSession(chatId),
      ...session,
      history: Array.isArray(session.history) ? session.history.slice(-config.SESSION_HISTORY_LIMIT) : [],
      pendingUploads: Array.isArray(session.pendingUploads) ? session.pendingUploads : [],
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

  setActiveTask(chatId: string | number, activeTask: ActiveTask | null): SessionState {
    return this.updateSession(chatId, (session) => {
      session.activeTask = activeTask;
      if (activeTask) session.lastRunner = activeTask.runner;
      return session;
    });
  }

  setTaskPid(chatId: string | number, pid: number | null): SessionState {
    return this.updateSession(chatId, (session) => {
      if (session.activeTask) session.activeTask.pid = pid;
      return session;
    });
  }

  setTaskProgress(chatId: string | number, progress: Record<string, unknown>): SessionState {
    return this.updateSession(chatId, (session) => {
      if (!session.activeTask) return session;
      session.activeTask.lastProgressAt = nowIso();
      session.activeTask.changedFiles = Array.isArray(progress.changedFiles)
        ? progress.changedFiles.map((value) => String(value))
        : [];
      session.activeTask.changedFileCount = Number(progress.changedFileCount) || session.activeTask.changedFiles.length || 0;
      session.activeTask.stdoutTail = progress.stdoutTail ? String(progress.stdoutTail) : null;
      session.activeTask.stderrTail = progress.stderrTail ? String(progress.stderrTail) : null;
      if (progress.branchName) session.activeTask.branchName = String(progress.branchName);
      if (progress.worktreePath !== undefined) session.activeTask.worktreePath = progress.worktreePath ? String(progress.worktreePath) : null;
      if (progress.commandSummary) session.activeTask.commandSummary = String(progress.commandSummary);
      return session;
    });
  }

  setLastResult(chatId: string | number, result: TaskResult): SessionState {
    return this.updateSession(chatId, (session) => {
      session.lastResult = result;
      session.lastRunner = result.runner;
      session.activeTask = null;
      return session;
    });
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
