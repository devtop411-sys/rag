import { getConnection, saveConnection, getApiKey } from "./fireflies.state.js";
import { listTranscripts } from "./fireflies.service.js";
import { ingestMeeting, getMeetingIngestState } from "./fireflies.ingest.js";

const MAX_INGESTS_PER_RUN = Number(process.env.FIREFLIES_MAX_INGESTS_PER_RUN) || 5;

function domainOf(email) {
  const at = String(email || "").split("@")[1];
  return at ? at.toLowerCase() : "";
}

function isExternal(meeting) {
  const orgDomain = domainOf(meeting.organizer);
  if (!orgDomain) return meeting.participants.length > 1;
  return meeting.participants.some(
    (p) => domainOf(p) && domainOf(p) !== orgDomain
  );
}

function passesFilters(meeting, settings) {
  if (settings.min_duration_minutes) {
    const minutes = meeting.duration || 0;
    if (minutes < settings.min_duration_minutes) return false;
  }
  if (settings.only_external && !isExternal(meeting)) return false;
  return true;
}

let progress = null;
let runState = {
  running:     false,
  started_at:  null,
  finished_at: null,
  progress:    null,
  result:      null,
  error:       null,
};
let current = null;

export function getSyncState() {
  return { ...runState, progress: runState.running ? progress : runState.progress };
}

/**
 * Starts a sync unless one is already in flight (single-flight, so a manual
 * "Sync now" and the scheduler can never run concurrently).
 *
 * @returns {{ started: boolean, already_running: boolean, promise: Promise<any> }}
 */
export function startSync(opts = {}) {
  if (runState.running) {
    return { started: false, already_running: true, promise: current };
  }

  progress  = null;
  runState  = {
    running:     true,
    started_at:  new Date().toISOString(),
    finished_at: null,
    progress:    null,
    result:      null,
    error:       null,
  };

  current = runSync(opts)
    .then((result) => {
      runState.result = result;
      return result;
    })
    .catch((err) => {
      runState.error = err.message;
      console.error("[fireflies] sync failed:", err.message);
      return { ok: false, error: err.message };
    })
    .finally(() => {
      runState.running     = false;
      runState.finished_at = new Date().toISOString();
      runState.progress    = progress;
      current              = null;
    });

  return { started: true, already_running: false, promise: current };
}

export async function runSync() {
  const conn = await getConnection();
  const apiKey = await getApiKey();

  if (!apiKey || conn.status !== "connected") {
    return { ok: false, reason: "not_connected" };
  }

  const settings = conn.auto_sync;
  const meetings = await listTranscripts(apiKey, { limit: 50 });
  const eligible = meetings.filter((m) => passesFilters(m, settings));

  const pending = [];
  const already = [];
  for (const m of eligible) {
    const state = await getMeetingIngestState(m.id);
    if (state.ingested) already.push(m);
    else pending.push(m);
  }
  pending.sort((a, b) => (b.date || 0) - (a.date || 0));

  const results = already.map((m) => ({
    id: m.id, title: m.title, status: "skipped", reason: "already ingested",
  }));
  let ingested = 0;
  let deferred = 0;

  for (const m of pending) {
    if (ingested >= MAX_INGESTS_PER_RUN) {
      deferred += 1;
      results.push({ id: m.id, title: m.title, status: "deferred" });
      continue;
    }

    try {
      progress = {
        done:    ingested,
        total:   Math.min(pending.length, MAX_INGESTS_PER_RUN),
        pending: pending.length,
        current: m.title,
      };
      console.log(`[fireflies] Ingesting (${ingested + 1}/${Math.min(pending.length, MAX_INGESTS_PER_RUN)}): "${m.title}"`);
      const r = await ingestMeeting(apiKey, m.id);
      ingested += 1;
      progress = { ...progress, done: ingested, current: m.title };
      results.push({ id: m.id, title: m.title, status: "ingested", chunks: r.chunks });
    } catch (err) {
      if (err.permanent) {
        results.push({ id: m.id, title: m.title, status: "skipped", reason: err.message });
        continue;
      }
      results.push({ id: m.id, title: m.title, status: "failed", error: err.message });
    }
  }

  const nextCursor = new Date().toISOString();
  await saveConnection({ last_synced_at: nextCursor });

  const failed = results.filter((r) => r.status === "failed").length;
  console.log(
    `[fireflies] Sync complete — ingested ${ingested}, deferred ${deferred}, failed ${failed}, pending ${pending.length}, eligible ${eligible.length}`
  );
  return {
    ok: true,
    ingested,
    deferred,
    failed,
    checked: eligible.length,
    pending: pending.length,
    results,
    last_synced_at: nextCursor,
  };
}

let timer = null;
let nextRunAt = 0;


const BACKLOG_RETRY_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 1000;

async function tickScheduler() {
  if (runState.running || Date.now() < nextRunAt) return;

  try {
    const conn = await getConnection();
    if (!conn.auto_sync?.enabled || conn.status !== "connected") return;

    const freqMs = (conn.auto_sync.frequency_minutes || 60) * 60 * 1000;
    nextRunAt = Date.now() + freqMs;

    const result = await startSync().promise;
    const hasBacklog =
      result?.ok && ((result.deferred ?? 0) > 0 || (result.failed ?? 0) > 0);
    if (hasBacklog || !result?.ok) {
      nextRunAt = Date.now() + Math.min(BACKLOG_RETRY_MS, freqMs);
    }
  } catch (err) {
    console.error("[fireflies] scheduled sync error:", err.message);
    nextRunAt = Date.now() + BACKLOG_RETRY_MS;
  }
}

export function startScheduler() {
  if (timer) return;

  const TICK_MS = 60 * 1000;
  nextRunAt = Date.now() + STARTUP_DELAY_MS;
  setTimeout(() => {
    tickScheduler().catch((err) =>
      console.error("[fireflies] startup sync error:", err.message)
    );
  }, STARTUP_DELAY_MS);

  timer = setInterval(() => {
    tickScheduler().catch((err) =>
      console.error("[fireflies] scheduled sync error:", err.message)
    );
  }, TICK_MS);

  if (typeof timer.unref === "function") timer.unref();
  console.log("[fireflies] Auto-sync scheduler started");
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
