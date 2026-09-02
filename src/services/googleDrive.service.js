const DRIVE_API = "https://www.googleapis.com/drive/v3";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

export const SHARED_ROOT_ID = "sharedWithMe";

export const VIRTUAL_ROOTS = {
  root:             "My Drive",
  [SHARED_ROOT_ID]: "Shared with me",
};

export function isVirtualRoot(id) {
  return Object.prototype.hasOwnProperty.call(VIRTUAL_ROOTS, id);
}

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
  const types = [FOLDER_MIME, SHORTCUT_MIME, ...Object.keys(INGESTIBLE_MIME)];
  return types.map((m) => `mimeType = '${m}'`).join(" or ");
}


function resolveShortcut(file) {
  if (file?.mimeType !== SHORTCUT_MIME) return file;
  const targetId = file.shortcutDetails?.targetId;
  if (!targetId) return file;
  return {
    ...file,
    id:       targetId,
    mimeType: file.shortcutDetails.targetMimeType ?? file.mimeType,
  };
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
    const err = new Error(`Google Drive error (${res.status}): ${body.slice(0, 240) || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function getDriveAccount(accessToken) {
  const res = await driveFetch(
    accessToken,
    `${DRIVE_API}/about?fields=user(displayName,emailAddress,photoLink)`
  );
  const data = await res.json();
  return {
    email:   data.user?.emailAddress ?? null,
    name:    data.user?.displayName ?? null,
    picture: data.user?.photoLink ?? null,
  };
}

export async function listDriveFiles(accessToken, {
  folderId = "root",
  pageToken,
  pageSize = 50,
  search = "",
} = {}) {
  const params = new URLSearchParams({
    pageSize: String(Math.min(Math.max(pageSize, 1), 100)),
    fields:
      "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink," +
      "shortcutDetails(targetId,targetMimeType))",
    orderBy: "folder,modifiedTime desc",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "allDrives",
    spaces: "drive",
    q: "",
  });

  const clauses = [`trashed = false`, `(${mimeQuery()})`];
  const trimmed = search.trim();
  if (trimmed) {
    clauses.push(`name contains '${escapeDriveQuery(trimmed)}'`);
  } else if (folderId === SHARED_ROOT_ID) {
    clauses.push("sharedWithMe = true");
  } else {
    clauses.push(`'${escapeDriveQuery(folderId)}' in parents`);
  }
  params.set("q", clauses.join(" and "));
  if (pageToken) params.set("pageToken", pageToken);

  const res = await driveFetch(accessToken, `${DRIVE_API}/files?${params}`);
  const data = await res.json();

  const files = (data.files ?? [])
    .map(resolveShortcut)
    .filter((f) => f.mimeType === FOLDER_MIME || isIngestible(f.mimeType));

  return { ...data, files };
}

/**
 * Walks one or more folder trees and returns every ingestible file inside them.
 *
 * Roots share a single file budget and dedupe set, so overlapping trees (a
 * shared folder that is also shortcutted into My Drive, say) yield each file
 * once.
 *
 * @param {object}   options
 * @param {string}   [options.folderId]  single root to walk
 * @param {string[]} [options.folderIds] several roots; takes precedence
 * @returns {Promise<{ files: object[], truncated: boolean, maxFiles: number }>}
 */
export async function listAllIngestibleFiles(accessToken, {
  folderId = "root",
  folderIds,
  maxFiles = 500,
} = {}) {
  const roots = folderIds?.length ? folderIds : [folderId];
  const files = [];
  const seenFolders = new Set();
  const seenFiles   = new Set();

  async function walk(currentFolderId) {
    if (seenFolders.has(currentFolderId)) return;
    seenFolders.add(currentFolderId);
    if (files.length >= maxFiles) return;

    let pageToken;
    do {
      const data = await listDriveFiles(accessToken, {
        folderId: currentFolderId,
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
        if (files.length >= maxFiles) break;
        await walk(id);
      }

      for (const file of ingestible) {
        if (files.length >= maxFiles) break;
        if (seenFiles.has(file.id)) continue;
        seenFiles.add(file.id);
        files.push(file);
      }

      pageToken = data.nextPageToken;
    } while (pageToken && files.length < maxFiles);
  }

  for (const root of roots) {
    if (files.length >= maxFiles) break;
    await walk(root);
  }

  return { files, truncated: files.length >= maxFiles, maxFiles };
}

export async function getDriveFileMeta(accessToken, fileId) {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,size,modifiedTime,webViewLink,shortcutDetails(targetId,targetMimeType)",
    supportsAllDrives: "true",
  });
  const res = await driveFetch(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`
  );
  const meta = resolveShortcut(await res.json());

  if (meta.id !== fileId) return getDriveFileMeta(accessToken, meta.id);
  return meta;
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
