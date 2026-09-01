import { runWithConcurrency } from "../utils/concurrency.utils.js";
import {
  FOLDER_MIME,
  VIRTUAL_ROOTS,
  isVirtualRoot,
  isIngestible,
  mimeLabel,
  getDriveAccount,
  listDriveFiles,
  listAllIngestibleFiles,
  getDriveFileMeta,
} from "../services/googleDrive.service.js";
import { getDriveIngestState, ingestDriveFiles } from "../services/drive.ingest.js";
import {
  getConnection,
  saveConnection,
  saveAccessToken,
  clearAccessToken,
  getAccessToken,
  hasLiveToken,
  publicConnection,
} from "../services/drive.state.js";
import { startSync, getSyncState } from "../services/drive.sync.js";

function sendError(res, err, fallbackStatus = 500) {
  const status = err.status && err.status < 600 ? err.status : fallbackStatus;
  res.status(status).json({ error: err.message });
}


async function requestAccessToken(req) {
  const header = (req.get("x-google-access-token") || "").trim();
  if (header) return header;
  return getAccessToken();
}

function publicFile(file, state = { ingested: false, chunks: 0 }) {
  const folder = file.mimeType === FOLDER_MIME;
  return {
    id:           file.id,
    name:         file.name,
    mimeType:     file.mimeType,
    type:         mimeLabel(file.mimeType),
    folder,
    ingestible:   !folder && isIngestible(file.mimeType),
    size:         file.size ? Number(file.size) : null,
    modifiedTime: file.modifiedTime ?? null,
    webViewLink:  file.webViewLink ?? null,
    ingested:     folder ? false : Boolean(state.ingested),
    chunks:       folder ? 0 : (state.chunks ?? 0),
  };
}

export async function status(req, res) {
  try {
    const conn = await getConnection();
    res.json({ ...publicConnection(conn), sync: getSyncState() });
  } catch (err) {
    sendError(res, err);
  }
}

export async function connect(req, res) {
  try {
    const accessToken = (req.body?.access_token || "").toString().trim();
    const expiresIn   = req.body?.expires_in;
    if (!accessToken) {
      return res.status(400).json({ error: "access_token is required" });
    }

    const previous = await getConnection();
    // Skip the extra Drive round trip on token renewals.
    let account = previous.account;
    if (!account) {
      try {
        account = await getDriveAccount(accessToken);
      } catch (err) {
        console.error("[drive/connect] could not read account info:", err.message);
        account = null;
      }
    }

    const conn = await saveAccessToken({ accessToken, expiresIn, account });

    const resumed = !hasLiveToken(previous);
    if (resumed) {
      console.log(`[drive] Connected as ${account?.email ?? conn.account?.email ?? "unknown account"}`);
  
      const ready = conn.auto_sync?.enabled
        ? conn
        : await saveConnection({ auto_sync: { enabled: true } });
      startSync();
      return res.json(publicConnection(ready));
    }
    res.json(publicConnection(conn));
  } catch (err) {
    console.error("[drive/connect] error:", err.message);
    sendError(res, err, 400);
  }
}

export async function disconnect(req, res) {
  try {
   
    const conn = await clearAccessToken();
    res.json(publicConnection(conn));
  } catch (err) {
    sendError(res, err);
  }
}

export async function files(req, res) {
  try {
    const accessToken = await requestAccessToken(req);

    const folderId  = (req.query.folderId || "root").toString();
    const search    = (req.query.search || "").toString();
    const pageToken = (req.query.pageToken || "").toString();
    const pageSize  = Math.min(parseInt(req.query.limit) || 50, 100);

    const data = await listDriveFiles(accessToken, {
      folderId,
      search,
      pageToken: pageToken || undefined,
      pageSize,
    });

    const withState = await runWithConcurrency(
      (data.files ?? []).map((f) => async () => {
        if (f.mimeType === FOLDER_MIME || !isIngestible(f.mimeType)) {
          return publicFile(f);
        }
        return publicFile(f, await getDriveIngestState(f.id));
      }),
      8
    );

    res.json({ files: withState, nextPageToken: data.nextPageToken ?? null });
  } catch (err) {
    console.error("[drive/files] error:", err.message);
    sendError(res, err);
  }
}

export async function listAll(req, res) {
  try {
    const accessToken = await requestAccessToken(req);

    const folderId     = (req.query.folderId || "root").toString();
    const skipIngested = req.query.skipIngested !== "0";
    const maxFiles     = Math.min(parseInt(req.query.limit) || 500, 1000);

    const { files: listed, truncated, maxFiles: cap } =
      await listAllIngestibleFiles(accessToken, { folderId, maxFiles });

    const withState = await runWithConcurrency(
      listed.map((f) => async () => publicFile(f, await getDriveIngestState(f.id))),
      8
    );
    const result = skipIngested ? withState.filter((f) => !f.ingested) : withState;

    res.json({
      files:    result,
      total:    result.length,
      scanned:  withState.length,
      truncated,
      maxFiles: cap,
    });
  } catch (err) {
    console.error("[drive/files/all] error:", err.message);
    sendError(res, err);
  }
}

export async function ingest(req, res) {
  try {
    const accessToken = await requestAccessToken(req);

    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: "ids array is required" });

    const results = await ingestDriveFiles(accessToken, ids);
    const allOk = results.every((r) => r.status === "ingested");
    const anyOk = results.some((r) => r.status === "ingested");
    res.json({
      status: allOk ? "ok" : anyOk ? "partial_success" : "failed",
      results,
    });
  } catch (err) {
    console.error("[drive/ingest] error:", err.message);
    sendError(res, err);
  }
}

export async function getSettings(req, res) {
  try {
    const conn = await getConnection();
    res.json({ auto_sync: conn.auto_sync, watch_folders: conn.watch_folders });
  } catch (err) {
    sendError(res, err);
  }
}

async function resolveWatchFolders(req, requested) {
  const resolved = [];
  const seen     = new Set();
  let accessToken;

  for (const entry of requested) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);

    if (isVirtualRoot(entry.id)) {
      resolved.push({ id: entry.id, name: VIRTUAL_ROOTS[entry.id] });
      continue;
    }

    accessToken ??= await requestAccessToken(req);
    const meta = await getDriveFileMeta(accessToken, entry.id);
    if (meta.mimeType !== FOLDER_MIME) {
      const err = new Error(`"${meta.name}" is not a folder`);
      err.status = 400;
      throw err;
    }
    resolved.push({ id: meta.id, name: meta.name });
  }

  return resolved;
}

export async function updateSettings(req, res) {
  try {
    const incoming = req.body?.auto_sync || {};
    const patch = {};
    if (typeof incoming.enabled === "boolean") patch.enabled = incoming.enabled;
    if (Number.isFinite(+incoming.frequency_minutes)) {
      patch.frequency_minutes = Math.max(60, +incoming.frequency_minutes);
    }
    if (typeof incoming.reingest_modified === "boolean") {
      patch.reingest_modified = incoming.reingest_modified;
    }
    const update = { auto_sync: patch };

    const requested = Array.isArray(req.body?.watch_folders)
      ? req.body.watch_folders
      : req.body?.watch_folder ? [req.body.watch_folder] : null;

    if (requested) {
      if (!requested.length) {
        return res.status(400).json({ error: "Watch at least one folder" });
      }
      update.watch_folders = await resolveWatchFolders(req, requested);
    }

    const conn = await saveConnection(update);
    res.json({ auto_sync: conn.auto_sync, watch_folders: conn.watch_folders });
  } catch (err) {
    console.error("[drive/settings] error:", err.message);
    sendError(res, err);
  }
}

export async function sync(req, res) {
  try {
    const conn = await getConnection();
    if (!hasLiveToken(conn)) {
      return res.status(400).json({ ok: false, reason: "not_connected" });
    }

    const { started, already_running } = startSync();
    res.status(202).json({ ok: true, started, already_running, sync: getSyncState() });
  } catch (err) {
    sendError(res, err);
  }
}

export async function syncStatus(req, res) {
  try {
    res.json({ sync: getSyncState() });
  } catch (err) {
    sendError(res, err);
  }
}
