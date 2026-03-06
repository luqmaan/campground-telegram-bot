const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT_DIR, '.env'));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  BOT_TOKEN: requireEnv('TELEGRAM_BOT_TOKEN'),
  GROUP_CHAT_ID: requireEnv('TELEGRAM_GROUP_CHAT_ID'),
  OWNER_USER_ID: requireEnv('TELEGRAM_OWNER_USER_ID'),
  MAX_AUTH_USERS: numberEnv('TELEGRAM_MAX_AUTH_USERS', 2),
  CHECK_INTERVAL_MS: numberEnv('CHECK_INTERVAL_MS', 10 * 60 * 1000),
  POLL_TIMEOUT_SECONDS: numberEnv('POLL_TIMEOUT_SECONDS', 30),
  CLAUDE_TIMEOUT_SECONDS: numberEnv('CLAUDE_TIMEOUT_SECONDS', 300),
  MONITOR_LOCK_STALE_MS: numberEnv('MONITOR_LOCK_STALE_MS', 20 * 60 * 1000),
  MONITOR_STATE_FILE: path.join(DATA_DIR, 'monitor-state.json'),
  MONITOR_LOCK_FILE: path.join(DATA_DIR, 'monitor-lock.json'),
  AUTH_STATE_FILE: path.join(DATA_DIR, 'auth.json'),
  HISTORY_FILE: path.join(DATA_DIR, 'history.json'),
  BOT_STATE_FILE: path.join(DATA_DIR, 'bot-state.json'),
};
