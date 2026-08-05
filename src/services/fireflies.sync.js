import { getConnection, saveConnection, getApiKey } from "./fireflies.state.js";
import { listTranscripts } from "./fireflies.service.js";
import { ingestMeeting, getMeetingIngestState } from "./fireflies.ingest.js";

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

  const candidates = meetings.filter((m) => {
    if (cursorMs != null && m.date != null && m.date <= cursorMs) return false;
    return passesFilters(m, settings);
  });

  const results = [];
  let ingested = 0;
  let maxDate = cursorMs || 0;
  let earliestFailedDate = null;

  for (const m of candidates) {
    if (m.date && m.date > maxDate) maxDate = m.date;
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
      if (m.date != null && (earliestFailedDate == null || m.date < earliestFailedDate)) {
        earliestFailedDate = m.date;
      }
      results.push({ id: m.id, title: m.title, status: "failed", error: err.message });
    }
  }

  let nextCursorMs = Math.max(maxDate, Date.now());
  if (earliestFailedDate != null) {
    nextCursorMs = Math.min(nextCursorMs, earliestFailedDate - 1);
  }
  const nextCursor = new Date(nextCursorMs).toISOString();
  await saveConnection({ last_synced_at: nextCursor });

  console.log(`[fireflies] Sync complete — ingested ${ingested}/${candidates.length}`);
  return { ok: true, ingested, checked: candidates.length, results, last_synced_at: nextCursor };
}

let timer = null;
let lastAutoRun = 0;

export function startScheduler() {
  if (timer) return;

  const TICK_MS = 60 * 1000;
  timer = setInterval(async () => {
    try {
      const conn = await getConnection();
      if (!conn.auto_sync?.enabled || conn.status !== "connected") return;

      const freqMs = (conn.auto_sync.frequency_minutes || 60) * 60 * 1000;
      if (Date.now() - lastAutoRun < freqMs) return;

      lastAutoRun = Date.now();
      await runSync();
    } catch (err) {
      console.error("[fireflies] scheduled sync error:", err.message);
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
