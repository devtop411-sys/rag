import {
  getConnection,
  saveConnection,
  getAccessToken,
  hasLiveToken,
} from "./drive.state.js";
import {
  FOLDER_MIME,
  listDriveFiles,
} from "./googleDrive.service.js";
import { ingestDriveFile, getDriveIngestedMeta } from "./drive.ingest.js";
import { DRIVE_DEFAULT_WATCH_FOLDERS } from "../config/constants.js";

const MAX_INGESTS_PER_RUN = Number(process.env.DRIVE_MAX_INGESTS_PER_RUN) || 15;
const MAX_PENDING_COLLECT = Number(process.env.DRIVE_MAX_PENDING_COLLECT) || 50;
const MAX_SCAN_FILES      = Number(process.env.DRIVE_MAX_SCAN_FILES) || 5000;

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

async function collectPending(accessToken, folders, conn) {
  const unusable = new Map(
    (conn.unusable_files ?? []).map((f) => [f.id, f])
  );

  const pending = [];
  let alreadyIngested = 0;
  let knownUnusable   = 0;
  let scanned         = 0;
  let hitScanCap      = false;
  const seenFolders   = new Set();
  const seenFiles     = new Set();

  async function consider(file) {
    if (seenFiles.has(file.id)) return;
    seenFiles.add(file.id);
    scanned += 1;
    if (scanned > MAX_SCAN_FILES) {
      hitScanCap = true;
      return;
    }

    const previouslyUnusable = unusable.get(file.id);
    if (previouslyUnusable && previouslyUnusable.modified_time === (file.modifiedTime ?? null)) {
      knownUnusable += 1;
      return;
    }

    const state = await getDriveIngestedMeta(file.id);
    if (!state.ingested) {
      pending.push({ ...file, _reason: "new" });
      return;
    }

    const changed =
      conn.auto_sync.reingest_modified &&
      file.modifiedTime &&
      state.modifiedTime &&
      file.modifiedTime !== state.modifiedTime;
    if (changed) pending.push({ ...file, _reason: "modified" });
    else alreadyIngested += 1;
  }

  async function walk(folderId) {
    if (seenFolders.has(folderId)) return;
    seenFolders.add(folderId);
    if (pending.length >= MAX_PENDING_COLLECT || hitScanCap) return;

    let pageToken;
    do {
      const data = await listDriveFiles(accessToken, {
        folderId,
        pageToken,
        pageSize: 100,
      });

      const subFolders = [];
      const ingestible = [];
      for (const file of data.files ?? []) {
        if (file.mimeType === FOLDER_MIME) subFolders.push(file.id);
        else ingestible.push(file);
      }

      for (const id of subFolders) {
        if (pending.length >= MAX_PENDING_COLLECT || hitScanCap) break;
        await walk(id);
      }

      for (const file of ingestible) {
        if (pending.length >= MAX_PENDING_COLLECT || hitScanCap) break;
        await consider(file);
      }

      pageToken = data.nextPageToken;
    } while (pageToken && pending.length < MAX_PENDING_COLLECT && !hitScanCap);
  }

  for (const folder of folders) {
    if (pending.length >= MAX_PENDING_COLLECT || hitScanCap) break;
    await walk(folder.id);
  }

  return {
    pending,
    alreadyIngested,
    knownUnusable,
    scanned,
    truncated: hitScanCap || pending.length >= MAX_PENDING_COLLECT,
    maxFiles: MAX_SCAN_FILES,
    unusable,
  };
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
  const folders = conn.watch_folders?.length
    ? conn.watch_folders
    : DRIVE_DEFAULT_WATCH_FOLDERS;

  const {
    pending,
    alreadyIngested,
    knownUnusable,
    scanned,
    truncated,
    maxFiles,
    unusable,
  } = await collectPending(accessToken, folders, conn);

  const results   = [];
  let ingested    = 0;
  let failed      = 0;
  let skipped     = 0;
  let deferred    = 0;
  let attempts    = 0;
  let authExpired = false;
  const newlyUnusable = [];
  const toIngest = pending.slice(0, MAX_INGESTS_PER_RUN);
  deferred = Math.max(0, pending.length - toIngest.length);
  for (let i = 0; i < deferred; i++) {
    const file = pending[MAX_INGESTS_PER_RUN + i];
    results.push({ id: file.id, name: file.name, status: "deferred" });
  }

  const total = toIngest.length;

  for (const file of toIngest) {
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
          `[drive] Authorization expired mid-run — ${toIngest.length - attempts + 1} file(s) deferred`
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
    `scanned ${scanned} across ${folders.map((f) => f.name).join(" + ")}`
  );

  return {
    ok: true,
    folders,
    ingested,
    deferred,
    failed,
    skipped,
    auth_expired:    authExpired,
    up_to_date:      alreadyIngested,
    known_unusable:  knownUnusable,
    scanned,
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

    const freqMs = (conn.auto_sync.frequency_minutes || 6 * 60) * 60 * 1000;
    nextRunAt = Date.now() + freqMs;

    const result = await startSync().promise;
    const hasBacklog =
      result?.ok && ((result.deferred ?? 0) > 0 || (result.failed ?? 0) > 0 || result.truncated);
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
