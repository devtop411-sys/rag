import { runWithConcurrency } from "../utils/concurrency.utils.js";
import {
  FOLDER_MIME,
  isIngestible,
  mimeLabel,
  getDriveAccount,
  listDriveFiles,
} from "../services/googleDrive.service.js";
import { getDriveIngestState, ingestDriveFiles } from "../services/drive.ingest.js";

function readAccessToken(req) {
  const header = req.headers["x-google-access-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const bodyToken = req.body?.accessToken;
  if (typeof bodyToken === "string" && bodyToken.trim()) return bodyToken.trim();
  return "";
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
    const accessToken = readAccessToken(req);
    if (!accessToken) {
      return res.json({ connected: false });
    }
    const account = await getDriveAccount(accessToken);
    res.json({ connected: true, account });
  } catch (err) {
    const statusCode = err.status && err.status < 500 ? err.status : 400;
    res.status(statusCode).json({ connected: false, error: err.message });
  }
}

export async function files(req, res) {
  try {
    const accessToken = readAccessToken(req);
    if (!accessToken) {
      return res.status(401).json({ error: "Not connected to Google Drive" });
    }

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

    const listed = data.files ?? [];
    const withState = await runWithConcurrency(
      listed.map((f) => async () => {
        if (f.mimeType === FOLDER_MIME || !isIngestible(f.mimeType)) {
          return publicFile(f);
        }
        const state = await getDriveIngestState(f.id);
        return publicFile(f, state);
      }),
      8
    );

    res.json({
      files:         withState,
      nextPageToken: data.nextPageToken ?? null,
    });
  } catch (err) {
    const statusCode = err.status && err.status < 500 ? err.status : 500;
    console.error("[drive/files] error:", err.message);
    res.status(statusCode).json({ error: err.message });
  }
}

export async function ingest(req, res) {
  try {
    const accessToken = readAccessToken(req);
    if (!accessToken) {
      return res.status(401).json({ error: "Not connected to Google Drive" });
    }

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
    const statusCode = err.status && err.status < 500 ? err.status : 500;
    console.error("[drive/ingest] error:", err.message);
    res.status(statusCode).json({ error: err.message });
  }
}
