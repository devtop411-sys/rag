import {
  getConnection,
  saveConnection,
  getAccessToken,
  hasLiveToken,
} from "./drive.state.js";
import { listAllIngestibleFiles } from "./googleDrive.service.js";
import { ingestDriveFile, getDriveIngestedMeta } from "./drive.ingest.js";

let progress = null;
let current  = null;
let runState = {
  running:     false,
  started_at:  null,
  finished_at: null,
  progress:    null,
  result:      null,
  error:       null,
};

export function getSyncState() {
  return { ...runState, progress: runState.running ? progress : runState.progress };
}

/**
 * Starts a sync unless one is already in flight, so a manual "Sync now" and the
 * scheduler can never run concurrently.
 *
 * @returns {{ started: boolean, already_running: boolean, promise: Promise<any> }}
 */
export function startSync() {
  if (runState.running) {
    return { started: false, already_running: true, promise: current };
  }

  progress = null;
  runState = {
    running:     true,
    started_at:  new Date().toISOString(),
    finished_at: null,
    progress:    null,
    result:      null,
    error:       null,
  };

  current = runSync()
    .then((result) => {
      runState.result = result;
      return result;
    })
    .catch((err) => {
      runState.error = err.message;
      console.error("[drive] sync failed:", err.message);
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

/**
 * Scans the watched folder and ingests everything that is not in Qdrant yet
 * (plus files whose Drive copy changed since ingest, when enabled).
 */
export async function runSync() {
  const conn = await getConnection();
  if (!hasLiveToken(conn)) {
    return { ok: false, reason: "not_connected" };
  }

  const accessToken = await getAccessToken();
  const folder = conn.watch_folder ?? { id: "root", name: "My Drive" };

  const { files, truncated, maxFiles } = await listAllIngestibleFiles(accessToken, {
    folderId: folder.id,
  });

  const unusable = new Map(
    (conn.unusable_files ?? []).map((f) => [f.id, f])
  );

  const pending = [];
  let alreadyIngested = 0;
  let knownUnusable   = 0;
  for (const file of files) {
    const previouslyUnusable = unusable.get(file.id);
    if (previouslyUnusable && previouslyUnusable.modified_time === (file.modifiedTime ?? null)) {
      knownUnusable += 1;
      continue;
    }

    const state = await getDriveIngestedMeta(file.id);
    if (!state.ingested) {
      pending.push({ ...file, _reason: "new" });
      continue;
    }
    const changed =
      conn.auto_sync.reingest_modified &&
      file.modifiedTime &&
      state.modifiedTime &&
      file.modifiedTime !== state.modifiedTime;
    if (changed) pending.push({ ...file, _reason: "modified" });
    else alreadyIngested += 1;
  }

  const results   = [];
  let ingested    = 0;
  let failed      = 0;
  let skipped     = 0;
  let deferred    = 0;
  let attempts    = 0;
  let authExpired = false;
  const newlyUnusable = [];
  const total     = pending.length;

  for (const file of pending) {
    if (authExpired) {
      deferred += 1;
      results.push({ id: file.id, name: file.name, status: "deferred" });
      continue;
    }

    progress = {
      done:    ingested,
      total,
      pending: pending.length,
      current: file.name,
    };

    attempts += 1;
    try {
      console.log(`[drive] Auto-ingest (${attempts}/${total}): "${file.name}" (${file._reason})`);
      const r = await ingestDriveFile(accessToken, file.id);
      ingested += 1;
      progress = { ...progress, done: ingested };
      results.push({
        id: file.id, name: file.name, status: "ingested", chunks: r.chunks, reason: file._reason,
      });
    } catch (err) {
      if (err.status === 401) {
        authExpired = true;
        deferred += 1;
        console.warn(
          `[drive] Authorization expired mid-run — ${pending.length - attempts + 1} file(s) deferred`
        );
        results.push({
          id: file.id, name: file.name, status: "deferred", reason: "authorization expired",
        });
        continue;
      }

      const givingUp = err.permanent || err.status === 404;
      if (givingUp) {
        skipped += 1;
        newlyUnusable.push({
          id:            file.id,
          name:          file.name,
          reason:        err.message,
          modified_time: file.modifiedTime ?? null,
        });
        console.warn(`[drive] Skipping "${file.name}": ${err.message}`);
        results.push({ id: file.id, name: file.name, status: "skipped", reason: err.message });
      } else {
        failed += 1;
        console.error(`[drive] Auto-ingest failed "${file.name}" (will retry):`, err.message);
        results.push({ id: file.id, name: file.name, status: "failed", error: err.message });
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const statePatch = { last_synced_at: finishedAt };
  if (newlyUnusable.length) {
    for (const entry of newlyUnusable) unusable.set(entry.id, entry);
    statePatch.unusable_files = [...unusable.values()].slice(-500);
  }
  await saveConnection(statePatch);

  console.log(
    `[drive] Sync complete — ingested ${ingested}, skipped ${skipped}, failed ${failed}, ` +
    `deferred ${deferred}, up-to-date ${alreadyIngested}, previously skipped ${knownUnusable}, ` +
    `scanned ${files.length}`
  );

  return {
    ok: true,
    folder,
    ingested,
    deferred,
    failed,
    skipped,
    auth_expired:    authExpired,
    up_to_date:      alreadyIngested,
    known_unusable:  knownUnusable,
    scanned:         files.length,
    truncated,
    maxFiles,
    results,
    last_synced_at:  finishedAt,
  };
}

let timer = null;
let nextRunAt = 0;

const BACKLOG_RETRY_MS = 60 * 1000;
const ERROR_RETRY_MS   = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 8 * 1000;
const TICK_MS          = 60 * 1000;

async function tickScheduler() {
  if (runState.running || Date.now() < nextRunAt) return;

  try {
    const conn = await getConnection();
    if (!conn.auto_sync?.enabled || !hasLiveToken(conn)) return;

    const freqMs = (conn.auto_sync.frequency_minutes || 60) * 60 * 1000;
    nextRunAt = Date.now() + freqMs;

    const result = await startSync().promise;
    const hasBacklog =
      result?.ok && ((result.deferred ?? 0) > 0 || (result.failed ?? 0) > 0);
    if (hasBacklog) {
      nextRunAt = Date.now() + Math.min(BACKLOG_RETRY_MS, freqMs);
    } else if (!result?.ok) {
      nextRunAt = Date.now() + Math.min(ERROR_RETRY_MS, freqMs);
    }
  } catch (err) {
    console.error("[drive] scheduled sync error:", err.message);
    nextRunAt = Date.now() + ERROR_RETRY_MS;
  }
}

export function startScheduler() {
  if (timer) return;

  nextRunAt = Date.now() + STARTUP_DELAY_MS;
  setTimeout(() => {
    tickScheduler().catch((err) =>
      console.error("[drive] startup sync error:", err.message)
    );
  }, STARTUP_DELAY_MS);

  timer = setInterval(() => {
    tickScheduler().catch((err) =>
      console.error("[drive] scheduled sync error:", err.message)
    );
  }, TICK_MS);

  if (typeof timer.unref === "function") timer.unref();
  console.log("[drive] Auto-ingest scheduler started");
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
