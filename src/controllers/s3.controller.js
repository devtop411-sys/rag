import path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  s3,
  S3_BUCKET,
  S3_PREFIX,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "../services/s3.service.js";
import { qdrant } from "../services/qdrant.service.js";
import { COLLECTION, ALLOWED_S3_EXTENSIONS } from "../config/constants.js";

// POST /api/s3/upload — upload files through the backend to S3
export async function uploadToS3(req, res) {
  try {
    if (!S3_BUCKET) return res.status(500).json({ error: "S3_BUCKET not configured" });
    if (!req.files?.length) {
      return res.status(400).json({ error: "No files received — ensure field name is 'files'" });
    }

    const listData = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: S3_PREFIX })
    );
    const existingNames = new Set(
      (listData.Contents ?? []).map((obj) =>
        obj.Key.replace(S3_PREFIX, "").replace(/^[0-9a-f-]+-/, "")
      )
    );

    const results = await Promise.all(
      req.files.map(async (file) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_S3_EXTENSIONS.has(ext)) {
          throw new Error(`Unsupported file type "${ext}". Allowed: .pdf .txt .md .docx`);
        }
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

        if (existingNames.has(safe)) {
          console.log(`[s3/upload] Skipped duplicate "${file.originalname}"`);
          return { fileName: file.originalname, key: null, duplicate: true };
        }

        const key = `${S3_PREFIX}${uuidv4()}-${safe}`;
        await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: file.buffer }));
        console.log(`[s3/upload] Uploaded "${file.originalname}" → ${key}`);
        return { fileName: file.originalname, key };
      })
    );

    res.json({ files: results });
  } catch (error) {
    console.error("[s3/upload] error:", error);
    res.status(500).json({ error: error.message });
  }
}

// GET /api/s3/files — list uploaded files in S3_PREFIX
export async function listS3Files(req, res) {
  try {
    if (!S3_BUCKET) return res.status(500).json({ error: "S3_BUCKET not configured" });

    const data = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: S3_PREFIX })
    );

    const files = (data.Contents ?? [])
      .filter((obj) => obj.Key !== S3_PREFIX)
      .map((obj) => ({
        key:          obj.Key,
        fileName:     obj.Key.replace(S3_PREFIX, "").replace(/^[0-9a-f-]+-/, ""),
        size:         obj.Size,
        lastModified: obj.LastModified,
      }));

    res.json({ files });
  } catch (error) {
    console.error("[s3/files] error:", error);
    res.status(500).json({ error: error.message });
  }
}

// DELETE /api/s3/file — delete a file from S3 (+ best-effort Qdrant cleanup)
export async function deleteS3File(req, res) {
  try {
    if (!S3_BUCKET) return res.status(500).json({ error: "S3_BUCKET not configured" });

    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "key is required" });

    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    console.log(`[s3/delete] Deleted S3 object: ${key}`);

    try {
      await qdrant.delete(COLLECTION, {
        wait:   true,
        filter: { must: [{ key: "fileKey", match: { value: key } }] },
      });
      console.log(`[s3/delete] Removed Qdrant vectors for fileKey: ${key}`);
    } catch { /* Qdrant cleanup is optional */ }

    res.json({ ok: true, key });
  } catch (error) {
    console.error("[s3/delete] error:", error);
    res.status(500).json({ error: error.message });
  }
}
