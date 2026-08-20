const DRIVE_API = "https://www.googleapis.com/drive/v3";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export const INGESTIBLE_MIME = {
  "application/pdf": { ext: ".pdf", exportMime: null, label: "PDF" },
  "text/plain":      { ext: ".txt", exportMime: null, label: "Text" },
  "text/markdown":   { ext: ".md",  exportMime: null, label: "Markdown" },
  "text/csv":        { ext: ".csv", exportMime: null, label: "CSV" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    ext: ".docx", exportMime: null, label: "Word",
  },
  "application/vnd.google-apps.document": {
    ext: ".txt", exportMime: "text/plain", label: "Google Doc",
  },
  "application/vnd.google-apps.spreadsheet": {
    ext: ".csv", exportMime: "text/csv", label: "Google Sheet",
  },
  "application/vnd.google-apps.presentation": {
    ext: ".txt", exportMime: "text/plain", label: "Google Slides",
  },
};

export function isIngestible(mimeType) {
  return Boolean(INGESTIBLE_MIME[mimeType]);
}

export function mimeLabel(mimeType) {
  if (mimeType === FOLDER_MIME) return "Folder";
  return INGESTIBLE_MIME[mimeType]?.label ?? mimeType;
}

function mimeQuery() {
  const types = [FOLDER_MIME, ...Object.keys(INGESTIBLE_MIME)];
  return types.map((m) => `mimeType = '${m}'`).join(" or ");
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveFetch(accessToken, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    const expired = res.status === 401 || /invalid.?credential|authError|unauthenticated/i.test(detail);
    if (expired) {
      const err = new Error("Google Drive authorization expired. Please reconnect.");
      err.status = 401;
      throw err;
    }
    const err = new Error(
      `Google Drive error (${res.status}): ${detail.slice(0, 240) || res.statusText}`
    );
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Drive error (${res.status}): ${body.slice(0, 240)}`);
  }
  return res;
}

export async function getDriveAccount(accessToken) {
  const res = await driveFetch(accessToken, "https://www.googleapis.com/oauth2/v3/userinfo");
  const data = await res.json();
  return { email: data.email, name: data.name, picture: data.picture };
}

export async function listDriveFiles(accessToken, {
  folderId = "root",
  pageToken,
  pageSize = 50,
  search = "",
} = {}) {
  const params = new URLSearchParams({
    pageSize: String(Math.min(Math.max(pageSize, 1), 100)),
    fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink)",
    orderBy: "folder,modifiedTime desc",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    spaces: "drive",
    q: "",
  });

  const clauses = [`trashed = false`, `(${mimeQuery()})`];
  const trimmed = search.trim();
  if (trimmed) {
    clauses.push(`name contains '${escapeDriveQuery(trimmed)}'`);
  } else {
    clauses.push(`'${escapeDriveQuery(folderId)}' in parents`);
  }
  params.set("q", clauses.join(" and "));
  if (pageToken) params.set("pageToken", pageToken);

  const res = await driveFetch(accessToken, `${DRIVE_API}/files?${params}`);
  return res.json();
}

export async function getDriveFileMeta(accessToken, fileId) {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,size,modifiedTime,webViewLink",
    supportsAllDrives: "true",
  });
  const res = await driveFetch(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`
  );
  return res.json();
}

export async function downloadDriveFile(accessToken, file) {
  const spec = INGESTIBLE_MIME[file.mimeType];
  if (!spec) {
    throw new Error(`Unsupported Google Drive type "${file.mimeType}"`);
  }

  const id = encodeURIComponent(file.id);
  const url = spec.exportMime
    ? `${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(spec.exportMime)}`
    : `${DRIVE_API}/files/${id}?alt=media`;

  const res = await driveFetch(accessToken, url);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, ext: spec.ext, fileName: file.name };
}
