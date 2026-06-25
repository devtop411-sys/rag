import path from "path";
import fs from "fs/promises";
import pdfParse from "pdf-parse";
import { v4 as uuidv4 } from "uuid";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import {
  ALLOWED_EXTENSIONS,
  MIME_MAP,
  EMBEDDING_MODEL,
  EXPECTED_DENSE_SIZE,
  COLLECTION,
  S3_BUCKET,
} from "../config/constants.js";
import { embedTexts } from "../services/embeddings.service.js";
import { qdrant, ensureCollection } from "../services/qdrant.service.js";
import {
  generateMetaQuery,
  extractDocumentMeta,
  extractText,
  streamToBuffer,
} from "../services/document.service.js";
import { s3, GetObjectCommand } from "../services/s3.service.js";
import { safeUnlink } from "../utils/file.utils.js";
import { parsePdfDate } from "../utils/date.utils.js";
import { runWithConcurrency } from "../utils/concurrency.utils.js";

// ---------------------------------------------------------------------------
// Returns true when at least one Qdrant point already exists for the given
// payload field/value pair.  Treats a missing collection as "not ingested".
// ---------------------------------------------------------------------------
async function isAlreadyIngested(filterKey, filterValue) {
  try {
    const result = await qdrant.scroll(COLLECTION, {
      filter: { must: [{ key: filterKey, match: { value: filterValue } }] },
      limit: 1,
      with_payload: false,
      with_vector: false,
    });
    return result.points.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared helper: chunk raw text using RecursiveCharacterTextSplitter.
// Markdown files are pre-split on header boundaries first.
// ---------------------------------------------------------------------------
async function chunkText(rawText, chunkSize, chunkOverlap) {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  const looksLikeMarkdown = /^#{1,3} /m.test(rawText);

  if (looksLikeMarkdown) {
    const sections = rawText
      .split(/\n(?=#{1,3} )/)
      .map((s) => s.trim())
      .filter(Boolean);

    const parts = await Promise.all(
      sections.map((s) => (s.length > chunkSize ? splitter.splitText(s) : [s]))
    );
    return parts.flat().filter(Boolean);
  }

  return splitter.splitText(rawText);
}

// ---------------------------------------------------------------------------
// POST /ingest — parse, chunk, embed (Voyage AI), upsert unnamed default vectors
// ---------------------------------------------------------------------------
export async function ingestFile(req, res) {
  const tempPath = req.file?.path;
  console.log("filereq", req.file);

  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      await safeUnlink(tempPath);
      return res.status(400).json({
        error: `Unsupported file type "${ext}". Allowed: .pdf, .txt, .md`,
      });
    }

    const originalFilename = req.file.originalname;

    if (await isAlreadyIngested("original_filename", originalFilename)) {
      await safeUnlink(tempPath);
      return res.status(409).json({
        error: `File "${originalFilename}" has already been ingested.`,
        already_ingested: true,
      });
    }

    const source           = req.body.source || req.file.originalname;
    const chunkSize        = parseInt(req.body.chunkSize)    || 1200;
    const chunkOverlap     = parseInt(req.body.chunkOverlap) || 250;
    const fileSize         = req.file.size;
    const mimeType         = MIME_MAP[ext] ?? "application/octet-stream";
    const fileType         = ext === ".pdf" ? "pdf" : "text";

    const callerAuthor = req.body.author?.trim() || null;
    const callerDate   = req.body.date?.trim()   || null;

    const buffer = await fs.readFile(tempPath);

    let rawText;
    let pdfAuthor = null;
    let pdfDate   = null;
    try {
      const parsed = await pdfParse(buffer);
      rawText   = parsed.text;
      pdfAuthor = parsed.info?.Author?.trim() || null;
      pdfDate   = parsePdfDate(parsed.info?.CreationDate || parsed.info?.ModDate);
    } catch {
      rawText = buffer.toString("utf8");
    }

    const chunks = await chunkText(rawText, chunkSize, chunkOverlap);
    if (!chunks.length) {
      await safeUnlink(tempPath);
      return res.status(400).json({ error: "No text chunks generated" });
    }

    console.log(`[ingest] "${source}" (${fileType}, ${fileSize} bytes) → ${chunks.length} chunks`);

    const denseEmbeddings = await embedTexts(chunks);

    if (denseEmbeddings[0].length !== EXPECTED_DENSE_SIZE) {
      await safeUnlink(tempPath);
      return res.status(500).json({
        error: `Unexpected embedding size: got ${denseEmbeddings[0].length}, expected ${EXPECTED_DENSE_SIZE}`,
      });
    }

    const metaQueryEnabled = !!process.env.OPENAI_API_KEY;
    let metaQueries = chunks.map(() => []);
    if (metaQueryEnabled) {
      console.log(`[ingest] Generating meta_query tags for ${chunks.length} chunks…`);
      metaQueries = await runWithConcurrency(
        chunks.map((text) => () => generateMetaQuery(text)),
        5
      );
      const totalTags = metaQueries.reduce((s, t) => s + t.length, 0);
      console.log(`[ingest] meta_query done — ${totalTags} tags across ${chunks.length} chunks`);
    }

    let author       = callerAuthor || pdfAuthor;
    let documentDate = callerDate   || pdfDate;
    if ((!author || !documentDate) && metaQueryEnabled) {
      const llmMeta = await extractDocumentMeta(rawText);
      author       = author       || llmMeta.author;
      documentDate = documentDate || llmMeta.date;
    }
    console.log(`[ingest] metadata → author="${author ?? "(none)"}", date="${documentDate ?? "(none)"}"`);

    const docTags = [];
    if (author)       docTags.push(`author:${author}`);
    if (documentDate) docTags.push(`date:${documentDate}`);

    await ensureCollection(denseEmbeddings[0].length);

    const documentId = uuidv4();
    const points = chunks.map((text, index) => ({
      id:     uuidv4(),
      vector: denseEmbeddings[index],
      payload: {
        document_id:       documentId,
        source,
        original_filename: originalFilename,
        mime_type:         mimeType,
        file_size:         fileSize,
        type:              fileType,
        chunk_index:       index,
        text,
        meta_query:        [...(metaQueries[index] ?? []), ...docTags],
        embedding_model:   EMBEDDING_MODEL,
        created_at:        new Date().toISOString(),
      },
    }));

    await qdrant.upsert(COLLECTION, { wait: true, points });
    await safeUnlink(tempPath);

    console.log(
      `[ingest] Upserted ${points.length} points (${EXPECTED_DENSE_SIZE}-dim Voyage AI) into "${COLLECTION}"`
    );

    res.json({
      ok:                true,
      document_id:       documentId,
      source,
      chunks:            chunks.length,
      meta_query_tagged: metaQueryEnabled,
      embedding_model:   EMBEDDING_MODEL,
      vector_size:       EXPECTED_DENSE_SIZE,
    });
  } catch (error) {
    console.error("[ingest] error:", error);
    await safeUnlink(tempPath);
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/ingest/s3 — download from S3, chunk, embed, upsert to Qdrant
// Body:  { files: [{ key, author?, date? }], knowledgeBaseId? }
// ---------------------------------------------------------------------------
export async function ingestFromS3(req, res) {
  try {
    if (!S3_BUCKET) return res.status(500).json({ error: "S3_BUCKET not configured" });

    const { files, knowledgeBaseId = "kb_default" } = req.body;
    if (!Array.isArray(files) || !files.length) {
      return res.status(400).json({ error: "files array is required" });
    }

    const results = [];

    for (const { key, author: fileAuthor, date: fileDate } of files) {
      try {
        const ext      = path.extname(key).toLowerCase();
        const fileName = path.basename(key).replace(/^[0-9a-f-]+-/, "");

        const callerAuthor =
          typeof fileAuthor === "string" && fileAuthor.trim() ? fileAuthor.trim() : null;
        const callerDate =
          typeof fileDate === "string" && fileDate.trim() ? fileDate.trim() : null;

        // 0. Skip if already ingested
        if (await isAlreadyIngested("fileKey", key)) {
          console.log(`[ingest/s3] Skipping "${key}" — already ingested`);
          results.push({ key, status: "skipped", reason: "already ingested" });
          continue;
        }

        // 1. Download from S3
        console.log(`[ingest/s3] Step 1: Downloading "${key}" from S3…`);
        const s3Obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        const buffer = await streamToBuffer(s3Obj.Body);
        const s3Date = s3Obj.LastModified
          ? new Date(s3Obj.LastModified).toISOString().slice(0, 10)
          : null;
        console.log(`[ingest/s3] Step 1: Downloaded ${buffer.length} bytes, S3 date: ${s3Date}`);

        // 2. Extract text
        console.log(`[ingest/s3] Step 2: Extracting text (ext=${ext})…`);
        let rawText;
        let pdfAuthor = null;
        if (ext === ".pdf") {
          const parsed = await pdfParse(buffer);
          rawText   = parsed.text;
          pdfAuthor = parsed.info?.Author?.trim() || null;
        } else {
          rawText = await extractText(buffer, ext);
        }
        if (!rawText.trim()) throw new Error("No text extracted from file");
        console.log(`[ingest/s3] Step 2: Extracted ${rawText.length} chars`);

        // 3. Chunk
        const chunks = await chunkText(rawText, 800, 150);
        if (!chunks.length) throw new Error("No chunks generated");
        console.log(`[ingest/s3] "${fileName}" → ${chunks.length} chunks`);

        // 4. Embed
        console.log(`[ingest/s3] Step 4: Embedding ${chunks.length} chunks…`);
        const embeddings = await embedTexts(chunks);
        console.log(`[ingest/s3] Step 4: Embeddings done (dim=${embeddings[0].length})`);

        // 5. Meta-query tags + document metadata
        const metaQueryEnabled = !!process.env.OPENAI_API_KEY;
        let metaQueries = chunks.map(() => []);
        if (metaQueryEnabled) {
          console.log(`[ingest/s3] Step 5: Generating meta-query tags…`);
          metaQueries = await runWithConcurrency(
            chunks.map((text) => () => generateMetaQuery(text)),
            5
          );
          console.log(`[ingest/s3] Step 5: Meta-query done`);
        }

        let author       = callerAuthor || pdfAuthor;
        let documentDate = callerDate   || s3Date;
        if (!author && metaQueryEnabled) {
          const llmMeta = await extractDocumentMeta(rawText);
          author = llmMeta.author;
        }
        console.log(
          `[ingest/s3] metadata → author="${author ?? "(none)"}", date="${documentDate ?? "(none)"}"`
        );

        const docTags = [];
        if (author)       docTags.push(`author:${author}`);
        if (documentDate) docTags.push(`date:${documentDate}`);

        // 6. Ensure collection
        console.log(`[ingest/s3] Step 6: Ensuring Qdrant collection…`);
        await ensureCollection(embeddings[0].length);
        console.log(`[ingest/s3] Step 6: Collection ready`);

        // 7. Upsert
        console.log(`[ingest/s3] Step 7: Upserting to Qdrant…`);
        const documentId = uuidv4();
        const points = chunks.map((text, i) => ({
          id:     uuidv4(),
          vector: embeddings[i],
          payload: {
            knowledgeBaseId,
            fileKey:         key,
            fileName,
            document_id:     documentId,
            source:          "s3",
            chunk_index:     i,
            text,
            meta_query:      [...(metaQueries[i] ?? []), ...docTags],
            embedding_model: EMBEDDING_MODEL,
            created_at:      new Date().toISOString(),
          },
        }));

        await qdrant.upsert(COLLECTION, { wait: true, points });
        console.log(`[ingest/s3] Upserted ${points.length} vectors for "${fileName}"`);

        results.push({ key, status: "ingested", chunks: chunks.length });
      } catch (err) {
        console.error(`[ingest/s3] Failed "${key}":`, {
          message:    err.message,
          code:       err.Code ?? err.code ?? err.name,
          statusCode: err.$metadata?.httpStatusCode,
          requestId:  err.$metadata?.requestId,
        });
        results.push({ key, status: "failed", error: err.message });
      }
    }

    const allOk = results.every((r) => r.status === "ingested");
    const anyOk = results.some((r)  => r.status === "ingested");
    res.json({
      status:  allOk ? "ok" : anyOk ? "partial_success" : "failed",
      results,
    });
  } catch (error) {
    console.error("[ingest/s3] error:", error);
    res.status(500).json({ error: error.message });
  }
}
