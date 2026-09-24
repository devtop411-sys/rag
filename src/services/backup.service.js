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

function qdrantHeaders() {
  const h = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) h["api-key"] = QDRANT_API_KEY;
  return h;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

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

async function uploadToS3(key, body) {
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
    partSize:  10 * 1024 * 1024,
    queueSize: 4,
  });

  await upload.done();
}

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

  await deleteQdrantSnapshot(collection, snapshotName);

  return { s3Key, snapshotName, sizeBytes: size };
}
