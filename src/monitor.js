const fs = require('node:fs');

const config = require('./config');
const { TARGETS, DATE_RANGES } = require('./monitor-config');

const RDR_BASE = 'https://california-rdr.prod.cali.rd12.recreation-management.tylerapp.com/rdr';

function ensureDir() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  ensureDir();
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

class CampgroundMonitor {
  constructor(sendTelegram) {
    this.sendTelegram = sendTelegram;
    this.interval = null;
    this.started = false;
  }

  defaultState() {
    return {
      alerted: {},
      lastCheck: 0,
      lastSuccessAt: null,
      lastError: null,
      checkIntervalMs: config.CHECK_INTERVAL_MS,
      schedulerEnabled: true,
      activeRun: null,
      runs: [],
      recentEvents: [],
    };
  }

  loadState() {
    const raw = readJson(config.MONITOR_STATE_FILE, this.defaultState());
    return {
      ...this.defaultState(),
      ...raw,
      runs: Array.isArray(raw.runs) ? raw.runs.slice(-10) : [],
      recentEvents: Array.isArray(raw.recentEvents) ? raw.recentEvents.slice(-20) : [],
    };
  }

  saveState(state) {
    writeJson(config.MONITOR_STATE_FILE, state);
  }

  recordEvent(state, message) {
    state.recentEvents = [...(state.recentEvents || []), `[${nowIso()}] ${message}`].slice(-20);
  }

  loadLock() {
    return readJson(config.MONITOR_LOCK_FILE, null);
  }

  acquireLock(mode) {
    const current = this.loadLock();
    const now = Date.now();
    if (current?.startedAt) {
      const startedAt = Date.parse(current.startedAt);
      if (!Number.isNaN(startedAt) && now - startedAt < config.MONITOR_LOCK_STALE_MS) {
        return false;
      }
    }
    writeJson(config.MONITOR_LOCK_FILE, {
      mode,
      pid: process.pid,
      startedAt: nowIso(),
    });
    return true;
  }

  releaseLock() {
    try {
      fs.rmSync(config.MONITOR_LOCK_FILE, { force: true });
    } catch {}
  }

  cleanupAlerts(state) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const key of Object.keys(state.alerted)) {
      if (state.alerted[key] < cutoff) {
        delete state.alerted[key];
      }
    }
  }

  async checkFacility(facilityId, startDate, nights) {
    try {
      const res = await fetch(`${RDR_BASE}/search/grid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({
          FacilityId: facilityId,
          StartDate: startDate,
          Nights: String(nights),
          IsADA: false,
          UnitCategoryId: 0,
          MinVehicleLength: 0,
          UnitTypesGroupIds: [],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const units = data?.Facility?.Units;
      if (!units) return null;
      const entries = Object.values(units);
      const availableUnits = entries.filter((unit) => unit.IsAvailable);
      return {
        available: availableUnits.length,
        total: entries.length,
        sites: availableUnits.slice(0, 5).map((unit) => ({
          name: unit.ShortName || unit.Name || '?',
          rate: unit.MinRate || 0,
        })),
      };
    } catch {
      return null;
    }
  }

  formatAlert(target, range, result) {
    const tierLabel = target.tier === 1 ? '🔥' : target.tier === 2 ? '⭐' : '📍';
    const siteList = result.sites.map((site) => `  ${site.name} ($${site.rate}/night)`).join('\n');
    return (
      `${tierLabel} <b>${target.parkName}</b> — ${target.facilityName}\n` +
      `${range.label}: <b>${result.available} sites available</b> (of ${result.total})\n` +
      siteList
    );
  }

  async runCheck(mode = 'scheduled') {
    const state = this.loadState();
    this.cleanupAlerts(state);

    if (!this.acquireLock(mode)) {
      this.recordEvent(state, `Skipped ${mode} run because another run is active`);
      this.saveState(state);
      return { skipped: true };
    }

    const startedAt = Date.now();
    const run = {
      startedAt: nowIso(),
      finishedAt: null,
      mode,
      success: false,
      durationMs: 0,
      checksAttempted: 0,
      successfulChecks: 0,
      facilitiesWithAvailability: 0,
      alertsSent: 0,
      errors: [],
    };

    state.activeRun = {
      mode,
      pid: process.pid,
      startedAt: run.startedAt,
    };
    this.recordEvent(state, `Started ${mode} run`);
    this.saveState(state);

    const alerts = [];
    let facilitiesWithAvailability = 0;
    const now = Date.now();

    try {
      for (const range of DATE_RANGES) {
        for (const target of TARGETS) {
          run.checksAttempted += 1;
          const key = `${target.facilityId}:${range.startDate}`;
          if (state.alerted[key] && now - state.alerted[key] < 2 * 60 * 60 * 1000) {
            continue;
          }

          const result = await this.checkFacility(target.facilityId, range.startDate, range.nights);
          if (!result) {
            if (run.errors.length < 5) {
              run.errors.push(`No response for ${target.parkName} ${target.facilityName} (${range.label})`);
            }
            continue;
          }

          run.successfulChecks += 1;
          if (result.available > 0) {
            facilitiesWithAvailability += 1;
            alerts.push(this.formatAlert(target, range, result));
            state.alerted[key] = now;
            this.recordEvent(state, `Availability found at ${target.parkName} ${target.facilityName} (${range.label})`);
          }

          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }

      if (alerts.length > 0) {
        const header = '<b>Campsite Alert — Apr 3-6 Weekend</b>\n\n';
        let message = header;
        for (const alert of alerts) {
          if (message.length + alert.length > 3800) {
            await this.sendTelegram(config.GROUP_CHAT_ID, message, { html: true });
            message = header;
          }
          message += `${alert}\n\n`;
        }
        await this.sendTelegram(config.GROUP_CHAT_ID, `${message}🔗 https://www.reservecalifornia.com`, { html: true });
      }

      state.lastCheck = Date.now();
      state.lastSuccessAt = state.lastCheck;
      state.lastError = null;
      run.success = true;
      run.alertsSent = alerts.length;
      run.facilitiesWithAvailability = facilitiesWithAvailability;
      this.recordEvent(state, `Completed ${mode} run: ${alerts.length} alerts, ${facilitiesWithAvailability} openings`);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      run.errors.push(state.lastError);
      this.recordEvent(state, `Failed ${mode} run: ${state.lastError}`);
    } finally {
      run.finishedAt = nowIso();
      run.durationMs = Date.now() - startedAt;
      state.activeRun = null;
      state.runs = [...state.runs, run].slice(-10);
      this.saveState(state);
      this.releaseLock();
    }

    return { skipped: false, run };
  }

  async startScheduler() {
    const state = this.loadState();
    if (!state.schedulerEnabled) {
      this.started = true;
      this.interval = null;
      return;
    }
    if (this.interval) return;

    this.started = true;
    await this.runCheck('scheduled');
    this.interval = setInterval(() => {
      void this.runCheck('scheduled');
    }, config.CHECK_INTERVAL_MS);
  }

  stopSchedulerLoop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  pauseScheduler() {
    const state = this.loadState();
    state.schedulerEnabled = false;
    this.recordEvent(state, 'Scheduler paused');
    this.saveState(state);
    this.stopSchedulerLoop();
  }

  async resumeScheduler() {
    const state = this.loadState();
    state.schedulerEnabled = true;
    this.recordEvent(state, 'Scheduler resumed');
    this.saveState(state);
    await this.startScheduler();
  }

  async restartScheduler() {
    this.stopSchedulerLoop();
    const state = this.loadState();
    state.schedulerEnabled = true;
    this.recordEvent(state, 'Scheduler restarted');
    this.saveState(state);
    await this.startScheduler();
  }

  latestRunSummary() {
    const state = this.loadState();
    const latest = state.runs[state.runs.length - 1];
    if (!latest) {
      return 'No completed monitor run yet.';
    }
    return `Latest run: ${latest.mode} ${latest.success ? 'ok' : 'failed'} at ${latest.finishedAt}. Alerts ${latest.alertsSent}, openings ${latest.facilitiesWithAvailability}, checks ${latest.successfulChecks}/${latest.checksAttempted}, duration ${Math.round(latest.durationMs / 1000)}s.`;
  }

  getStatus() {
    const state = this.loadState();
    return {
      schedulerEnabled: Boolean(state.schedulerEnabled),
      activeRun: state.activeRun,
      lastCheck: state.lastCheck,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      runs: state.runs.slice(-3).reverse(),
      recentEvents: state.recentEvents.slice(-10).reverse(),
    };
  }
}

module.exports = {
  CampgroundMonitor,
};
