const fs = require('node:fs');

const config = require('./config.ts');
const { DATE_RANGES, PARK_INFO, TARGETS } = require('./monitor-config.ts');
const { formatDuration, nowIso, previewText, readJson, writeJson } = require('./utils.ts');

const RDR_BASE = 'https://california-rdr.prod.cali.rd12.recreation-management.tylerapp.com/rdr';

// Date helpers for 6-month release window
function parseApiDate(mmddyyyy: string): Date {
  const [mm, dd, yyyy] = mmddyyyy.split('-');
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

function toSliceKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00`;
}

function formatApiDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}-${d.getFullYear()}`;
}

function formatDateRange(startDate: string, nights: number): string {
  const start = parseApiDate(startDate);
  const end = new Date(start.getTime() + nights * 86400000);
  const startStr = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const endStr = end.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${startStr} – ${endStr}`;
}

function computeReleaseDate(from: Date): Date {
  const y = from.getFullYear();
  const mo = from.getMonth();
  const d = from.getDate();
  const targetMonth = mo + 6;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;
  const lastDayOfTargetMonth = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  const targetDay = Math.min(d, lastDayOfTargetMonth);
  return new Date(targetYear, normalizedMonth, targetDay);
}

type SendTelegramFn = (chatId: string | number, text: string, options?: { threadId?: number | null; html?: boolean }) => Promise<void>;
type FacilityCheckResult = {
  available: number;
  total: number;
  sites: Array<{ name: string; rate: number }>;
};
type ProxyResponse = {
  ok?: boolean;
  status?: number;
  body?: string;
  error?: string | null;
};

function reserveCaliforniaHeaders(): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    Origin: 'https://www.reservecalifornia.com',
    Pragma: 'no-cache',
    Referer: 'https://www.reservecalifornia.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  };
}

class CampgroundMonitor {
  sendTelegram: SendTelegramFn;
  interval: ReturnType<typeof setInterval> | null;
  started: boolean;
  lastCheckError: string | null;

  constructor(sendTelegram: SendTelegramFn) {
    this.sendTelegram = sendTelegram;
    this.interval = null;
    this.started = false;
    this.lastCheckError = null;
  }

  defaultState(): Record<string, unknown> {
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
      dailyStats: null,
    };
  }

  loadState(): Record<string, unknown> {
    const raw = readJson(config.MONITOR_STATE_FILE, this.defaultState());
    return {
      ...this.defaultState(),
      ...raw,
      runs: Array.isArray(raw.runs) ? raw.runs.slice(-10) : [],
      recentEvents: Array.isArray(raw.recentEvents) ? raw.recentEvents.slice(-20) : [],
    };
  }

  saveState(state: Record<string, unknown>): void {
    writeJson(config.MONITOR_STATE_FILE, state);
  }

  recordEvent(state: Record<string, unknown>, message: string): void {
    state.recentEvents = [...(Array.isArray(state.recentEvents) ? state.recentEvents : []), `[${nowIso()}] ${message}`].slice(-20);
  }

  loadLock(): Record<string, unknown> | null {
    return readJson(config.MONITOR_LOCK_FILE, null);
  }

  acquireLock(mode: string): boolean {
    const current = this.loadLock();
    const now = Date.now();
    if (current?.startedAt) {
      const startedAt = Date.parse(String(current.startedAt));
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

  releaseLock(): void {
    try {
      fs.rmSync(config.MONITOR_LOCK_FILE, { force: true });
    } catch {}
  }

  cleanupAlerts(state: Record<string, unknown>): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const alerted = state.alerted || {};
    for (const key of Object.keys(alerted)) {
      if (alerted[key] < cutoff) {
        delete alerted[key];
      }
    }
    state.alerted = alerted;
  }

  scopeSummary(): Record<string, unknown> {
    return {
      targetCount: TARGETS.length,
      rangeCount: DATE_RANGES.length,
      totalChecks: TARGETS.length * DATE_RANGES.length,
    };
  }

  scopeMessage(): string {
    const scope = this.scopeSummary();
    const parks = new Map<string, string[]>();
    for (const target of TARGETS) {
      if (!parks.has(target.parkName)) {
        parks.set(target.parkName, []);
      }
      parks.get(target.parkName)?.push(target.facilityName);
    }

    const lines = [
      `Current monitor scope: ${scope.totalChecks} checks per run`,
      `Targets: ${scope.targetCount} campground loops / sections`,
      `Date ranges: ${scope.rangeCount}`,
      '',
      'Date ranges:',
    ];

    DATE_RANGES.forEach((range) => {
      lines.push(`- ${range.label}: ${range.startDate}`);
    });

    lines.push('', 'Parks:');
    for (const [parkName, facilities] of parks.entries()) {
      lines.push(`- ${parkName}: ${facilities.join(', ')}`);
    }

    return lines.join('\n');
  }

  activeRunSummary(): string {
    const state = this.loadState();
    const activeRun = state.activeRun;
    if (!activeRun) {
      return 'No monitor run is active.';
    }

    const startedAt = Date.parse(String(activeRun.startedAt || ''));
    const elapsedMs = Number.isNaN(startedAt) ? 0 : Date.now() - startedAt;
    const totalChecks = Number(activeRun.totalChecks) || 0;
    const checksAttempted = Number(activeRun.checksAttempted) || 0;
    const successfulChecks = Number(activeRun.successfulChecks) || 0;
    const facilitiesWithAvailability = Number(activeRun.facilitiesWithAvailability) || 0;
    const currentParkName = String(activeRun.currentParkName || '').trim();
    const currentFacilityName = String(activeRun.currentFacilityName || '').trim();
    const currentRangeLabel = String(activeRun.currentRangeLabel || '').trim();
    const lines = [`${activeRun.mode} run in progress for ${formatDuration(elapsedMs)}.`];

    if (totalChecks > 0) {
      lines.push(`Progress: ${checksAttempted}/${totalChecks} checks, ${successfulChecks} successful responses.`);
    }
    if (currentParkName && currentFacilityName && currentRangeLabel) {
      lines.push(`Current: ${currentParkName} / ${currentFacilityName} / ${currentRangeLabel}`);
    }
    lines.push(`Openings found so far: ${facilitiesWithAvailability}`);
    return lines.join('\n');
  }

  async fetchReserveCaliforniaJson(url: string, body: string, headers: Record<string, string>): Promise<Record<string, unknown> | null> {
    const signal = AbortSignal.timeout(config.RESERVE_CA_REQUEST_TIMEOUT_MS);

    try {
      if (config.RESERVE_CA_USE_CF_PROXY) {
        const proxyResponse = await fetch(config.RESERVE_CA_CF_PROXY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Scrape-Secret': config.RESERVE_CA_CF_PROXY_SECRET,
          },
          body: JSON.stringify({
            url,
            method: 'POST',
            headers,
            body,
          }),
          signal,
        });
        if (!proxyResponse.ok) {
          this.lastCheckError = `cfproxy transport HTTP ${proxyResponse.status}`;
          return null;
        }

        let proxyData: ProxyResponse;
        try {
          proxyData = await proxyResponse.json();
        } catch (error) {
          this.lastCheckError = `cfproxy JSON parse failed: ${error instanceof Error ? error.message : String(error)}`;
          return null;
        }

        const targetStatus = Number(proxyData?.status) || 0;
        if (!proxyData?.ok) {
          const detail = previewText(proxyData?.error || proxyData?.body || '', 160);
          this.lastCheckError = detail
            ? `Reserve California via cfproxy HTTP ${targetStatus || 'unknown'}: ${detail}`
            : `Reserve California via cfproxy HTTP ${targetStatus || 'unknown'}`;
          return null;
        }

        try {
          return JSON.parse(String(proxyData.body || 'null'));
        } catch (error) {
          this.lastCheckError = `Reserve California via cfproxy returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
          return null;
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal,
      });
      if (!response.ok) {
        this.lastCheckError = `Reserve California HTTP ${response.status}`;
        return null;
      }
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        this.lastCheckError = `Reserve California request timed out after ${config.RESERVE_CA_REQUEST_TIMEOUT_MS}ms`;
      } else if (error instanceof Error && error.name === 'AbortError') {
        this.lastCheckError = `Reserve California request aborted after ${config.RESERVE_CA_REQUEST_TIMEOUT_MS}ms`;
      } else {
        this.lastCheckError = error instanceof Error ? error.message : String(error);
      }
      return null;
    }
  }

  async checkFacility(facilityId: number, startDate: string, nights: number): Promise<FacilityCheckResult | null> {
    this.lastCheckError = null;

    try {
      const data = await this.fetchReserveCaliforniaJson(
        `${RDR_BASE}/search/grid`,
        JSON.stringify({
          FacilityId: facilityId,
          StartDate: startDate,
          Nights: String(nights),
          IsADA: false,
          UnitCategoryId: 0,
          MinVehicleLength: 0,
          UnitTypesGroupIds: [],
        }),
        reserveCaliforniaHeaders(),
      );
      if (!data) return null;
      const units = data?.Facility?.Units;
      if (!units) {
        this.lastCheckError = 'Reserve California response did not include Facility.Units';
        return null;
      }
      const entries = Object.values(units) as Record<string, unknown>[];

      // Build slice keys for all requested consecutive nights (API uses YYYY-MM-DDT00:00:00 keys)
      const startMs = parseApiDate(startDate).getTime();
      const sliceKeys: string[] = [];
      for (let n = 0; n < nights; n++) {
        sliceKeys.push(toSliceKey(new Date(startMs + n * 86400000)));
      }

      const availableUnits = entries.filter((unit: Record<string, unknown>) => {
        if (!unit.AllowWebBooking) return false;
        const slices = (unit.Slices as Record<string, Record<string, unknown>>) || {};
        return sliceKeys.every((k) => slices[k]?.IsFree === true);
      });

      return {
        available: availableUnits.length,
        total: entries.length,
        sites: availableUnits.slice(0, 5).map((unit: Record<string, unknown>) => ({
          name: unit.ShortName || unit.Name || '?',
          rate: unit.MinRate || 0,
        })),
      };
    } catch (error) {
      this.lastCheckError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async checkFacilityForDate(facilityId: number, targetDateApiFormat: string): Promise<FacilityCheckResult | null> {
    this.lastCheckError = null;
    try {
      const data = await this.fetchReserveCaliforniaJson(
        `${RDR_BASE}/search/grid`,
        JSON.stringify({
          FacilityId: facilityId,
          StartDate: targetDateApiFormat,
          Nights: '1',
          IsADA: false,
          UnitCategoryId: 0,
          MinVehicleLength: 0,
          UnitTypesGroupIds: [],
        }),
        reserveCaliforniaHeaders(),
      );
      if (!data) return null;
      const units = data?.Facility?.Units;
      if (!units) {
        this.lastCheckError = 'Reserve California response did not include Facility.Units';
        return null;
      }
      const entries = Object.values(units) as Record<string, unknown>[];
      const sliceKey = toSliceKey(parseApiDate(targetDateApiFormat));
      const availableUnits = entries.filter((unit: Record<string, unknown>) => {
        if (!unit.AllowWebBooking) return false;
        const slices = (unit.Slices as Record<string, Record<string, unknown>>) || {};
        return slices[sliceKey]?.IsFree === true;
      });
      return {
        available: availableUnits.length,
        total: entries.length,
        sites: availableUnits.slice(0, 10).map((unit: Record<string, unknown>) => ({
          name: unit.ShortName || unit.Name || '?',
          rate: unit.MinRate || 0,
        })),
      };
    } catch (error) {
      this.lastCheckError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  getReleaseDate(from?: Date): Date {
    return computeReleaseDate(from || new Date());
  }

  async runReleaseCheck(): Promise<{
    releaseDate: string;
    releaseDateIso: string;
    releaseDateLabel: string;
    foundCount: number;
    results: Array<{ target: Record<string, unknown>; available: number; total: number; sites: Array<{ name: unknown; rate: unknown }> }>;
    errors: string[];
    checkedAt: string;
  }> {
    const releaseDate = computeReleaseDate(new Date());
    const releaseDateApiFormat = formatApiDate(releaseDate);
    const releaseDateIso = toSliceKey(releaseDate).split('T')[0];
    const releaseDateLabel = releaseDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const results: Array<{ target: Record<string, unknown>; available: number; total: number; sites: Array<{ name: unknown; rate: unknown }> }> = [];
    const errors: string[] = [];

    const CONCURRENCY = 10;
    for (let i = 0; i < TARGETS.length; i += CONCURRENCY) {
      const batch = TARGETS.slice(i, i + CONCURRENCY) as Record<string, unknown>[];
      const batchResults = await Promise.all(
        batch.map(async (target: Record<string, unknown>) => {
          const result = await this.checkFacilityForDate(Number(target.facilityId), releaseDateApiFormat);
          const error = this.lastCheckError;
          return { target, result, error };
        }),
      );
      for (const { target, result, error } of batchResults) {
        if (!result) {
          if (errors.length < 5) errors.push(`${target.parkName} ${target.facilityName}: ${error || 'No response'}`);
          continue;
        }
        if (result.available > 0) {
          results.push({ target, available: result.available, total: result.total, sites: result.sites });
        }
      }
    }

    return { releaseDate: releaseDateApiFormat, releaseDateIso, releaseDateLabel, foundCount: results.length, results, errors, checkedAt: nowIso() };
  }

  formatAlert(target: Record<string, unknown>, range: Record<string, unknown>, result: Record<string, unknown>): string {
    const tier = Number(target.tier);
    const tierEmoji = tier === 1 ? '🔥' : tier === 2 ? '⭐' : '📍';
    const tierText = tier === 1 ? 'Tier 1 — High demand' : tier === 2 ? 'Tier 2 — Great pick' : 'Tier 3 — Good option';
    const parkInfo = (PARK_INFO as Record<string, { parkId: number; description: string }>)[String(target.parkName)];
    const bookingUrl = parkInfo
      ? `https://www.reservecalifornia.com/#!park/${parkInfo.parkId}/${target.facilityId}`
      : 'https://www.reservecalifornia.com';
    const description = parkInfo?.description ?? '';
    const siteList = (result.sites as Array<Record<string, unknown>>).map((site) => `  ${site.name} ($${site.rate}/night)`).join('\n');
    return (
      `${tierEmoji} <b>${target.parkName}</b> — ${target.facilityName} | ${tierText}\n` +
      (description ? `<i>${description}</i>\n` : '') +
      `${formatDateRange(String(range.startDate), Number(range.nights))} (${range.nights} nights): <b>${result.available} sites available</b> (of ${result.total})\n` +
      siteList + '\n' +
      `🔗 <a href="${bookingUrl}">Book on ReserveCalifornia</a>`
    );
  }

  async runCheck(mode = 'scheduled'): Promise<Record<string, unknown>> {
    const state = this.loadState();
    this.cleanupAlerts(state);

    if (!this.acquireLock(mode)) {
      this.recordEvent(state, `Skipped ${mode} run because another run is active`);
      this.saveState(state);
      return { skipped: true };
    }

    const startedAt = Date.now();
    const run: Record<string, unknown> = {
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
    const scope = this.scopeSummary();

    state.activeRun = {
      mode,
      pid: process.pid,
      startedAt: run.startedAt,
      totalChecks: scope.totalChecks,
      checksAttempted: 0,
      successfulChecks: 0,
      facilitiesWithAvailability: 0,
      currentParkName: null,
      currentFacilityName: null,
      currentRangeLabel: null,
      lastUpdatedAt: run.startedAt,
    };
    this.recordEvent(state, `Started ${mode} run`);
    this.saveState(state);

    const alerts: string[] = [];
    const newOpenings: Array<{ parkName: string; facilityName: string; rangeLabel: string; available: number }> = [];
    let facilitiesWithAvailability = 0;
    const now = Date.now();

    try {
      const CONCURRENCY = 10;
      const allTasks: Array<{ target: Record<string, unknown>; range: Record<string, unknown>; key: string }> = [];
      for (const range of DATE_RANGES) {
        for (const target of TARGETS) {
          allTasks.push({ target, range, key: `${target.facilityId}:${range.startDate}` });
        }
      }

      for (let i = 0; i < allTasks.length; i += CONCURRENCY) {
        const batch = allTasks.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async ({ target, range, key }) => {
            run.checksAttempted += 1;
            if (state.alerted[key] && now - state.alerted[key] < 2 * 60 * 60 * 1000) {
              return { target, range, key, skipped: true, result: null as FacilityCheckResult | null, error: null as string | null };
            }
            const result = await this.checkFacility(Number(target.facilityId), String(range.startDate), Number(range.nights));
            const error = this.lastCheckError;
            return { target, range, key, skipped: false, result, error };
          }),
        );

        for (const { target, range, key, skipped, result, error } of batchResults) {
          if (skipped) continue;
          if (!result) {
            if (run.errors.length < 5) {
              run.errors.push(`${target.parkName} ${target.facilityName} (${range.label}): ${error || 'No response'}`);
            }
            continue;
          }
          run.successfulChecks += 1;
          if (result.available > 0) {
            facilitiesWithAvailability += 1;
            alerts.push(this.formatAlert(target, range, result));
            newOpenings.push({ parkName: String(target.parkName), facilityName: String(target.facilityName), rangeLabel: String(range.label), available: result.available });
            state.alerted[key] = now;
            this.recordEvent(state, `Availability found at ${target.parkName} ${target.facilityName} (${range.label})`);
          }
        }

        const lastTask = batch[batch.length - 1];
        state.activeRun = {
          ...(state.activeRun || {}),
          mode,
          pid: process.pid,
          startedAt: run.startedAt,
          totalChecks: scope.totalChecks,
          checksAttempted: run.checksAttempted,
          successfulChecks: run.successfulChecks,
          facilitiesWithAvailability,
          currentParkName: lastTask.target.parkName,
          currentFacilityName: lastTask.target.facilityName,
          currentRangeLabel: lastTask.range.label,
          lastUpdatedAt: nowIso(),
        };
        this.saveState(state);
      }

      if (alerts.length > 0) {
        const rangeLabel = DATE_RANGES.length === 1
          ? formatDateRange(DATE_RANGES[0].startDate, DATE_RANGES[0].nights)
          : DATE_RANGES.map((r) => formatDateRange(r.startDate, r.nights)).join(' · ');
        const header = `<b>Campsite Alert — ${rangeLabel}</b>\n\n`;
        let message = header;
        for (const alert of alerts) {
          if (message.length + alert.length > 3800) {
            await this.sendTelegram(config.GROUP_CHAT_ID, message, { html: true });
            message = header;
          }
          message += `${alert}\n\n`;
        }
        await this.sendTelegram(config.GROUP_CHAT_ID, message.trimEnd(), { html: true });
      }

      state.lastCheck = Date.now();
      state.lastSuccessAt = state.lastCheck;
      state.lastError = null;
      run.success = true;
      run.alertsSent = alerts.length;
      run.facilitiesWithAvailability = facilitiesWithAvailability;
      this.recordEvent(state, `Completed ${mode} run: ${alerts.length} alerts, ${facilitiesWithAvailability} openings`);

      const todayDate = this.localDateString();
      const existingDaily = state.dailyStats as Record<string, unknown> | null;
      if (!existingDaily || existingDaily.date !== todayDate) {
        state.dailyStats = { date: todayDate, totalRuns: 0, successfulRuns: 0, openings: [] };
      }
      const daily = state.dailyStats as Record<string, unknown>;
      daily.totalRuns = (Number(daily.totalRuns) || 0) + 1;
      daily.successfulRuns = (Number(daily.successfulRuns) || 0) + 1;
      if (newOpenings.length > 0) {
        daily.openings = [...(Array.isArray(daily.openings) ? daily.openings : []), ...newOpenings];
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      run.errors.push(state.lastError);
      this.recordEvent(state, `Failed ${mode} run: ${state.lastError}`);
    } finally {
      run.finishedAt = nowIso();
      run.durationMs = Date.now() - startedAt;
      state.activeRun = null;
      state.runs = [...(Array.isArray(state.runs) ? state.runs : []), run].slice(-10);
      this.saveState(state);
      this.releaseLock();
    }

    return { skipped: false, run };
  }

  async startScheduler(): Promise<void> {
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

  stopSchedulerLoop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  pauseScheduler(): void {
    const state = this.loadState();
    state.schedulerEnabled = false;
    this.recordEvent(state, 'Scheduler paused');
    this.saveState(state);
    this.stopSchedulerLoop();
  }

  async resumeScheduler(): Promise<void> {
    const state = this.loadState();
    state.schedulerEnabled = true;
    this.recordEvent(state, 'Scheduler resumed');
    this.saveState(state);
    await this.startScheduler();
  }

  async restartScheduler(): Promise<void> {
    this.stopSchedulerLoop();
    const state = this.loadState();
    state.schedulerEnabled = true;
    this.recordEvent(state, 'Scheduler restarted');
    this.saveState(state);
    await this.startScheduler();
  }

  localDateString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  latestRunSummary(): string {
    const state = this.loadState();
    const latest = state.runs[state.runs.length - 1];
    if (!latest) {
      return 'No completed monitor run yet.';
    }
    return `Latest run: ${latest.mode} ${latest.success ? 'ok' : 'failed'} at ${latest.finishedAt}. Alerts ${latest.alertsSent}, openings ${latest.facilitiesWithAvailability}, checks ${latest.successfulChecks}/${latest.checksAttempted}, duration ${Math.round(latest.durationMs / 1000)}s.`;
  }

  getDailySummaryMessage(): string {
    const state = this.loadState();
    const todayDate = this.localDateString();
    const daily = (state.dailyStats && (state.dailyStats as Record<string, unknown>).date === todayDate)
      ? (state.dailyStats as Record<string, unknown>)
      : null;

    const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const parks: string[] = [];
    const seenParks = new Set<string>();
    for (const target of TARGETS) {
      if (!seenParks.has(String(target.parkName))) {
        seenParks.add(String(target.parkName));
        parks.push(String(target.parkName));
      }
    }

    const lines = [`📊 <b>Daily Summary — ${dateLabel}</b>`];

    if (daily) {
      const totalRuns = Number(daily.totalRuns) || 0;
      const successfulRuns = Number(daily.successfulRuns) || 0;
      const intervalMin = Math.round(config.CHECK_INTERVAL_MS / 60000);
      lines.push(`\nRan <b>${totalRuns}</b> checks today (${successfulRuns} successful, every ${intervalMin} min)`);
    } else {
      lines.push('\nNo checks recorded today yet.');
    }

    lines.push(`\n🏕️ Monitoring: ${parks.join(', ')}`);

    const openings = daily && Array.isArray(daily.openings) ? daily.openings as Array<Record<string, unknown>> : [];
    if (openings.length === 0) {
      lines.push('\n✅ No openings found today. Keep watching!');
    } else {
      const seen = new Map<string, number>();
      for (const o of openings) {
        const key = `${o.parkName}|${o.facilityName}|${o.rangeLabel}`;
        seen.set(key, Math.max(seen.get(key) || 0, Number(o.available) || 0));
      }
      lines.push(`\n🔔 <b>${seen.size} opening(s) found today:</b>`);
      for (const [key, count] of seen.entries()) {
        const [parkName, facilityName, rangeLabel] = key.split('|');
        lines.push(`  • ${parkName} — ${facilityName} (${rangeLabel}): ${count} site(s)`);
      }
      lines.push('\n🔗 https://www.reservecalifornia.com');
    }

    return lines.join('\n');
  }

  getStatus(): Record<string, unknown> {
    const state = this.loadState();
    return {
      schedulerEnabled: Boolean(state.schedulerEnabled),
      activeRun: state.activeRun,
      lastCheck: state.lastCheck,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      runs: Array.isArray(state.runs) ? state.runs.slice(-3).reverse() : [],
      recentEvents: Array.isArray(state.recentEvents) ? state.recentEvents.slice(-10).reverse() : [],
    };
  }
}

module.exports = {
  CampgroundMonitor,
};
