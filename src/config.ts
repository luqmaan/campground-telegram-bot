const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PROMPT_DIR = path.join(DATA_DIR, 'prompts');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const WORKTREE_BASE_DIR = path.join(ROOT_DIR, '..', '.campground-bot-worktrees');

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

loadEnvFile(path.join(ROOT_DIR, '.env'));

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  LOG_DIR,
  SESSION_DIR,
  UPLOAD_DIR,
  PROMPT_DIR,
  TMP_DIR,
  WORKTREE_BASE_DIR,
  BOT_WRAPPER_PATH: path.join(ROOT_DIR, 'bin', 'run-bot.sh'),
  AGENT_WRAPPER_PATH: path.join(ROOT_DIR, 'bin', 'run-agent.sh'),
  BOT_TOKEN: requireEnv('TELEGRAM_BOT_TOKEN'),
  GROUP_CHAT_ID: requireEnv('TELEGRAM_GROUP_CHAT_ID'),
  OWNER_USER_ID: requireEnv('TELEGRAM_OWNER_USER_ID'),
  MAX_AUTH_USERS: numberEnv('TELEGRAM_MAX_AUTH_USERS', 2),
  CHECK_INTERVAL_MS: numberEnv('CHECK_INTERVAL_MS', 2 * 60 * 1000),
  POLL_TIMEOUT_SECONDS: numberEnv('POLL_TIMEOUT_SECONDS', 30),
  CLAUDE_TIMEOUT_SECONDS: numberEnv('CLAUDE_TIMEOUT_SECONDS', 0),
  CODEX_TIMEOUT_SECONDS: numberEnv('CODEX_TIMEOUT_SECONDS', numberEnv('CLAUDE_TIMEOUT_SECONDS', 0)),
  RUNNER_PROGRESS_INTERVAL_MS: numberEnv('RUNNER_PROGRESS_INTERVAL_MS', 3_000),
  RUNNER_IDLE_PROGRESS_INTERVAL_MS: numberEnv('RUNNER_IDLE_PROGRESS_INTERVAL_MS', 45_000),
  RUNNER_PROGRESS_OUTPUT_CHARS: numberEnv('RUNNER_PROGRESS_OUTPUT_CHARS', 1_200),
  SESSION_HISTORY_LIMIT: numberEnv('SESSION_HISTORY_LIMIT', 16),
  RUNNER_STDOUT_TAIL_CHARS: numberEnv('RUNNER_STDOUT_TAIL_CHARS', 2000),
  RUNNER_FINAL_MESSAGE_CHARS: numberEnv('RUNNER_FINAL_MESSAGE_CHARS', 3200),
  RUNNER_SUMMARY_CHARS: numberEnv('RUNNER_SUMMARY_CHARS', 600),
  MONITOR_LOCK_STALE_MS: numberEnv('MONITOR_LOCK_STALE_MS', 20 * 60 * 1000),
  CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'sonnet',
  CODEX_MODEL: process.env.CODEX_MODEL || '',
  RESERVE_CA_USE_CF_PROXY: booleanEnv('RESERVE_CA_USE_CF_PROXY', true),
  RESERVE_CA_CF_PROXY_URL: process.env.RESERVE_CA_CF_PROXY_URL || 'https://scrape-proxy.ldawoodjee.workers.dev',
  RESERVE_CA_CF_PROXY_SECRET: process.env.RESERVE_CA_CF_PROXY_SECRET || 'solefeed-scrape-2026',
  RESERVE_CA_REQUEST_TIMEOUT_MS: numberEnv('RESERVE_CA_REQUEST_TIMEOUT_MS', 15_000),
  MONITOR_STATE_FILE: path.join(DATA_DIR, 'monitor-state.json'),
  MONITOR_LOCK_FILE: path.join(DATA_DIR, 'monitor-lock.json'),
  AUTH_STATE_FILE: path.join(DATA_DIR, 'auth.json'),
  BOT_STATE_FILE: path.join(DATA_DIR, 'bot-state.json'),
  DEPLOY_STATE_FILE: path.join(DATA_DIR, 'deploy-state.json'),
  DEFAULT_BRANCH: process.env.DEFAULT_BRANCH || 'main',
  PM2_APP_NAME: process.env.PM2_APP_NAME || 'bilal69-bot',
  PM2_MONITOR_APP_NAME: process.env.PM2_MONITOR_APP_NAME || 'bilal69-monitor',
};
