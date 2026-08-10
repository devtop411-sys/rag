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
    const minutes = (meeting.duration || 0) / 60;
    if (minutes < settings.min_duration_minutes) return false;
  }
  if (settings.only_external && !isExternal(meeting)) return false;
  return true;
}

export async function runSync({ force = false } = {}) {
  const conn = await getConnection();
  const apiKey = await getApiKey();

  if (!apiKey || conn.status !== "connected") {
    return { ok: false, reason: "not_connected" };
  }

  const settings = conn.auto_sync;
  const cursorMs = conn.last_synced_at ? Date.parse(conn.last_synced_at) : null;

  if (cursorMs == null && !force) {
    const now = new Date().toISOString();
    await saveConnection({ last_synced_at: now });
    return { ok: true, initialized: true, ingested: 0, checked: 0, results: [] };
  }

  const meetings = await listTranscripts(apiKey, { limit: 50 });

  const candidates = meetings
    .filter((m) => {
      if (cursorMs != null && m.date != null && m.date <= cursorMs) return false;
      return passesFilters(m, settings);
    })
    .sort((a, b) => (a.date || 0) - (b.date || 0));

  const results = [];
  let ingested = 0;
  let deferred = 0;
  let maxDate = cursorMs || 0;

  let earliestPendingDate = null;
  const holdCursor = (m) => {
    if (m.date != null && (earliestPendingDate == null || m.date < earliestPendingDate)) {
      earliestPendingDate = m.date;
    }
  };

  for (const m of candidates) {
    if (m.date && m.date > maxDate) maxDate = m.date;

    if (ingested >= MAX_INGESTS_PER_RUN) {
      deferred += 1;
      holdCursor(m);
      results.push({ id: m.id, title: m.title, status: "deferred" });
      continue;
    }

    try {
      const state = await getMeetingIngestState(m.id);
      if (state.ingested) {
        results.push({ id: m.id, title: m.title, status: "skipped", reason: "already ingested" });
        continue;
      }
      const r = await ingestMeeting(apiKey, m.id);
      ingested += 1;
      results.push({ id: m.id, title: m.title, status: "ingested", chunks: r.chunks });
    } catch (err) {
      if (err.permanent) {
        results.push({ id: m.id, title: m.title, status: "skipped", reason: err.message });
        continue;
      }
      holdCursor(m);
      results.push({ id: m.id, title: m.title, status: "failed", error: err.message });
    }
  }

  let nextCursorMs = Math.max(maxDate, Date.now());
  if (earliestPendingDate != null) {
    nextCursorMs = Math.min(nextCursorMs, earliestPendingDate - 1);
  }
  if (cursorMs != null) nextCursorMs = Math.max(nextCursorMs, cursorMs); // never rewind
  const nextCursor = new Date(nextCursorMs).toISOString();
  await saveConnection({ last_synced_at: nextCursor });

  const failed = results.filter((r) => r.status === "failed").length;
  console.log(
    `[fireflies] Sync complete — ingested ${ingested}, deferred ${deferred}, failed ${failed}, of ${candidates.length} candidate(s)`
  );
  return {
    ok: true,
    ingested,
    deferred,
    failed,
    checked: candidates.length,
    results,
    last_synced_at: nextCursor,
  };
}

let timer = null;
let nextRunAt = 0;
let running = false;

const BACKLOG_RETRY_MS = 5 * 60 * 1000;

export function startScheduler() {
  if (timer) return;

  const TICK_MS = 60 * 1000;
  timer = setInterval(async () => {
    if (running || Date.now() < nextRunAt) return;

    try {
      const conn = await getConnection();
      if (!conn.auto_sync?.enabled || conn.status !== "connected") return;

      const freqMs = (conn.auto_sync.frequency_minutes || 60) * 60 * 1000;
      running = true;
      nextRunAt = Date.now() + freqMs;

      const result = await runSync();
      if (result?.ok && (result.deferred > 0 || result.failed > 0)) {
        nextRunAt = Date.now() + Math.min(BACKLOG_RETRY_MS, freqMs);
      }
    } catch (err) {
      console.error("[fireflies] scheduled sync error:", err.message);
    } finally {
      running = false;
    }
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
