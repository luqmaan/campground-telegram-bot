const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureParentDir(filePath: string): void {
  ensureDir(path.dirname(filePath));
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripAnsi(value: unknown): string {
  return String(value || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function previewText(value: unknown, limit = 160): string | null {
  const compact = sanitizeText(value);
  if (!compact) return null;
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function tailText(value: unknown, limit = 1200): string {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

function appendCapped(current: string, chunk: string, limit = 200_000): string {
  const next = `${current}${chunk}`;
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatSince(epochMs: number | null | undefined): string {
  if (!epochMs) return 'never';
  const diff = Date.now() - epochMs;
  return `${new Date(epochMs).toISOString()} (${formatDuration(diff)} ago)`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value: string, fallback = 'task'): string {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function makeId(prefix = 'task'): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function safeFileName(value: string, fallback = 'file'): string {
  const name = String(value || '').trim();
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function relativeDisplayPath(filePath: string, rootDir: string): string {
  if (!filePath) return filePath;
  if (filePath.startsWith(rootDir)) {
    return path.relative(rootDir, filePath) || '.';
  }
  return filePath;
}

function lastLines(value: unknown, maxLines = 12): string {
  const lines = String(value || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return lines.slice(-maxLines).join('\n');
}

module.exports = {
  appendCapped,
  ensureDir,
  ensureParentDir,
  formatDuration,
  formatSince,
  lastLines,
  makeId,
  nowIso,
  previewText,
  readJson,
  relativeDisplayPath,
  safeFileName,
  sanitizeText,
  sleep,
  slugify,
  stripAnsi,
  tailText,
  writeJson,
};
