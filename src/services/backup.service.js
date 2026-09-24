/**
 * Qdrant → S3 backup service.
 *
 * Flow:
 *   1. POST /collections/{name}/snapshots         → create snapshot
 *   2. GET  /collections/{name}/snapshots/{snap}   → download .snapshot file
 *   3. PUT  s3://<bucket>/backups/<name>_<ts>.snapshot
 *   4. (optional) DELETE old snapshot from Qdrant to save disk
 *
 * S3 key layout:  backups/{collection}_{ISO-timestamp}.snapshot
 */

import { Readable } from "node:stream";
import { Upload }   from "@aws-sdk/lib-storage";
import { s3, S3_BUCKET } from "./s3.service.js";
import { COLLECTION }    from "../config/constants.js";

const QDRANT_URL = (process.env.QDRANT_URL || "http://localhost:6333").replace(
  /\/$/,
  "",
);
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const BACKUP_PREFIX  = "backups/";

// ── helpers ───────────────────────────────────────────────────────────────────

function qdrantHeaders() {
  const h = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) h["api-key"] = QDRANT_API_KEY;
  return h;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── core ──────────────────────────────────────────────────────────────────────

/**
 * Create a point-in-time snapshot for a collection.
 * @param {string} collection
 * @returns {Promise<string>} snapshot filename (e.g. "investment_memos-123…-…-.snapshot")
 */
async function createSnapshot(collection = COLLECTION) {
  const res = await fetch(
    `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/snapshots`,
    { method: "POST", headers: qdrantHeaders() },
  );
  if (!res.ok) {
    throw new Error(
      `Qdrant snapshot create failed (${res.status}): ${await res.text()}`,
    );
  }
  const body = await res.json();
  return body.result.name;
}

/**
 * Stream the snapshot file from Qdrant.
 * @param {string} collection
 * @param {string} snapshotName
 * @returns {Promise<{stream: ReadableStream, size: number}>}
 */
async function downloadSnapshot(collection, snapshotName) {
  const url = `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`;
  const res = await fetch(url, { headers: qdrantHeaders() });
  if (!res.ok) {
    throw new Error(
      `Qdrant snapshot download failed (${res.status}): ${await res.text()}`,
    );
  }
  const size = Number(res.headers.get("content-length") || 0);
  return { stream: res.body, size };
}

/**
 * Upload a readable stream to S3 under backups/.
 * Uses multipart upload so large snapshots don't need to fit in memory.
 * @param {string}   key
 * @param {ReadableStream | Readable} body
 */
async function uploadToS3(key, body) {
  // Convert web ReadableStream → Node Readable if needed
  const nodeStream =
    body instanceof Readable ? body : Readable.fromWeb(body);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket:      S3_BUCKET,
      Key:         key,
      Body:        nodeStream,
      ContentType: "application/octet-stream",
    },
    // 10 MB parts, up to 4 concurrent uploads
    partSize:  10 * 1024 * 1024,
    queueSize: 4,
  });

  await upload.done();
}

/**
 * Delete a snapshot from Qdrant (free disk space after upload).
 * @param {string} collection
 * @param {string} snapshotName
 */
async function deleteQdrantSnapshot(collection, snapshotName) {
  const url = `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`;
  const res = await fetch(url, {
    method:  "DELETE",
    headers: qdrantHeaders(),
  });
  if (!res.ok) {
    console.warn(
      `[backup] Could not delete Qdrant snapshot ${snapshotName}: ${res.status}`,
    );
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Full backup: snapshot → download → S3.
 * @param {string} [collection]
 * @returns {Promise<{s3Key: string, snapshotName: string, sizeBytes: number}>}
 */
export async function backupCollection(collection = COLLECTION) {
  console.log(`[backup] Creating snapshot for "${collection}"…`);
  const snapshotName = await createSnapshot(collection);
  console.log(`[backup] Snapshot created: ${snapshotName}`);

  const { stream, size } = await downloadSnapshot(collection, snapshotName);
  const s3Key = `${BACKUP_PREFIX}${collection}_${timestamp()}.snapshot`;

  console.log(
    `[backup] Uploading to s3://${S3_BUCKET}/${s3Key} (${size ? (size / 1024 / 1024).toFixed(1) + " MB" : "unknown size"})…`,
  );
  await uploadToS3(s3Key, stream);
  console.log(`[backup] Upload complete → ${s3Key}`);

  // Clean up the snapshot on the Qdrant side
  await deleteQdrantSnapshot(collection, snapshotName);

  return { s3Key, snapshotName, sizeBytes: size };
}
