const { spawnSync } = require('node:child_process');

const config = require('../src/config.ts');
const { nowIso, sanitizeText, writeJson } = require('../src/utils.ts');
const deployDelayMs = Number(process.env.CAMPGROUND_DEPLOY_DELAY_MS || '0') || 0;

function run(command: string, args: string[], allowFailure = false): string {
  const result = spawnSync(command, args, {
    cwd: config.ROOT_DIR,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed: ${sanitizeText(result.stderr || result.stdout).slice(-600)}`);
  }
  return String(result.stdout || '').trim();
}

function save(state: Record<string, unknown>): void {
  writeJson(config.DEPLOY_STATE_FILE, state);
}

const baseState = {
  status: 'running',
  requestedAt: nowIso(),
  startedAt: nowIso(),
  requestedBy: process.env.CAMPGROUND_DEPLOY_REQUESTED_BY || 'unknown',
  requestedRef: process.env.CAMPGROUND_DEPLOY_REQUESTED_REF || null,
  headBefore: null,
  headAfter: null,
  finishedAt: null,
  error: null,
};

try {
  if (deployDelayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, deployDelayMs);
  }
  baseState.headBefore = run('git', ['rev-parse', '--short', 'HEAD']);
  save(baseState);

  run('pm2', ['delete', config.PM2_APP_NAME], true);
  run('pm2', ['start', 'ecosystem.config.cjs', '--only', config.PM2_APP_NAME]);
  run('pm2', ['save']);

  baseState.status = 'succeeded';
  baseState.headAfter = run('git', ['rev-parse', '--short', 'HEAD']);
  baseState.finishedAt = nowIso();
  save(baseState);
} catch (error) {
  baseState.status = 'failed';
  baseState.finishedAt = nowIso();
  baseState.error = error instanceof Error ? error.message : String(error);
  try {
    baseState.headAfter = run('git', ['rev-parse', '--short', 'HEAD'], true);
  } catch {}
  save(baseState);
  process.exit(1);
}
