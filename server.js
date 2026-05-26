import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { QdrantClient } from "@qdrant/js-client-rest";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ---------------------------------------------------------------------------
// Embedding model config — single source of truth
// Both ingest and query MUST use the same model and size.
// ---------------------------------------------------------------------------
const EMBEDDING_MODEL     = "text-embedding-3-small";
const EXPECTED_DENSE_SIZE = 1536;

// ---------------------------------------------------------------------------
// Multer — 20 MB file size limit
// ---------------------------------------------------------------------------
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 20 * 1024 * 1024 },
});

const COLLECTION = process.env.QDRANT_COLLECTION || "investment_memos";

const ALLOWED_EXTENSIONS = new Set([".pdf", ".txt", ".md"]);

const MIME_MAP = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md":  "text/markdown",
};

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const qdrant = new QdrantClient({
  url:    process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY || undefined,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// API key middleware
// ---------------------------------------------------------------------------
function requireApiKey(req, res, next) {
  const configuredKey = process.env.API_KEY;
  if (!configuredKey) return next();
  const provided = req.headers["x-api-key"];
  if (!provided || provided !== configuredKey) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing x-api-key" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Embeddings — OpenAI text-embedding-3-small (1536 dims)
// Used for BOTH document ingestion and query search — never mix models.
// ---------------------------------------------------------------------------
async function embedTexts(texts) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured in .env");
  }

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  // OpenAI batch responses are ordered by `index`, sort to be safe
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

// ---------------------------------------------------------------------------
// Sparse vector helpers — TF encoder with FNV-1a hashing trick
// Sparse vectors are model-agnostic; they work regardless of dense size.
// ---------------------------------------------------------------------------
const VOCAB_SIZE = 30000;

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","was","are","were","be","been","have","has","had","do","does",
  "did","will","would","could","should","may","might","this","that","these",
  "those","it","its","i","we","you","he","she","they","not","no","so","if",
  "as","up","out","about","into","than","then","also","can",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function hashToken(token) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < token.length; i++) {
    h = (h ^ token.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % VOCAB_SIZE;
}

function buildSparseVector(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return { indices: [0], values: [0.0] };

  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  const indexMap = new Map();
  for (const [token, count] of freq) {
    const idx = hashToken(token);
    const tf  = count / tokens.length;
    indexMap.set(idx, (indexMap.get(idx) ?? 0) + tf);
  }

  const indices = [...indexMap.keys()];
  const values  = indices.map((i) => indexMap.get(i));
  return { indices, values };
}

// ---------------------------------------------------------------------------
// Qdrant collection — hybrid: named dense (OpenAI 1536) + sparse (TF)
// Auto-migrates collections that have wrong size or missing sparse vector.
// ---------------------------------------------------------------------------
async function ensureCollection(denseSize) {
  const { collections } = await qdrant.getCollections();
  const exists = collections.some((c) => c.name === COLLECTION);

  if (exists) {
    const info            = await qdrant.getCollection(COLLECTION);
    const currentSize     = info.config?.params?.vectors?.dense?.size;
    const hasDenseNamed   = !!info.config?.params?.vectors?.dense;
    const hasSparseVector = !!info.config?.params?.sparse_vectors?.sparse;

    if (hasDenseNamed && currentSize === denseSize && hasSparseVector) {
      return; // Already correct — nothing to do
    }

    const reason = !hasDenseNamed
      ? "legacy single-vector schema (no named vectors)"
      : !hasSparseVector
        ? "missing sparse vector"
        : `dense size mismatch (${currentSize} → ${denseSize})`;

    console.log(`[ensureCollection] Recreating "${COLLECTION}": ${reason}`);
    await qdrant.deleteCollection(COLLECTION);
  }

  await qdrant.createCollection(COLLECTION, {
    vectors: {
      dense: { size: denseSize, distance: "Cosine" },
    },
    sparse_vectors: {
      sparse: { index: { on_disk: false } },
    },
  });

  console.log(`[ensureCollection] Created "${COLLECTION}" (dense=${denseSize}, distance=Cosine, sparse=TF)`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildContext(matches) {
  return matches
    .map((m, i) => `SOURCE ${i + 1}
source: ${m.payload.source}
chunk_index: ${m.payload.chunk_index}
score: ${m.score.toFixed(4)}

${m.payload.text}`)
    .join("\n\n---\n\n");
}

async function safeUnlink(filePath) {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// POST /ingest — parse, chunk, embed (OpenAI), upsert dense + sparse vectors
// ---------------------------------------------------------------------------
app.post("/ingest", requireApiKey, upload.single("file"), async (req, res) => {
  const tempPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file" });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      await safeUnlink(tempPath);
      return res.status(400).json({
        error: `Unsupported file type "${ext}". Allowed: .pdf, .txt, .md`,
      });
    }

    const source           = req.body.source || req.file.originalname;
    const chunkSize        = parseInt(req.body.chunkSize)    || 1200;
    const chunkOverlap     = parseInt(req.body.chunkOverlap) || 250;
    const originalFilename = req.file.originalname;
    const fileSize         = req.file.size;
    const mimeType         = MIME_MAP[ext] ?? "application/octet-stream";
    const fileType         = ext === ".pdf" ? "pdf" : "text";

    const buffer = await fs.readFile(tempPath);

    let rawText;
    try {
      const parsed = await pdfParse(buffer);
      rawText = parsed.text;
    } catch {
      rawText = buffer.toString("utf8");
    }

    const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
    const chunks   = await splitter.splitText(rawText);

    if (!chunks.length) {
      await safeUnlink(tempPath);
      return res.status(400).json({ error: "No text chunks generated" });
    }

    console.log(`[ingest] "${source}" (${fileType}, ${fileSize} bytes) → ${chunks.length} chunks`);

    // Dense embeddings via OpenAI text-embedding-3-small → 1536 dims
    const denseEmbeddings = await embedTexts(chunks);

    // Validate returned vector size matches expected
    if (denseEmbeddings[0].length !== EXPECTED_DENSE_SIZE) {
      await safeUnlink(tempPath);
      return res.status(500).json({
        error: `Unexpected embedding size: got ${denseEmbeddings[0].length}, expected ${EXPECTED_DENSE_SIZE}`,
      });
    }

    await ensureCollection(denseEmbeddings[0].length);

    const documentId = uuidv4();

    const points = chunks.map((text, index) => ({
      id:      uuidv4(),
      vectors: {
        dense:  denseEmbeddings[index],          // 1536-dim OpenAI vector
        sparse: buildSparseVector(text),          // TF sparse vector for keyword search
      },
      payload: {
        document_id:       documentId,
        source,
        original_filename: originalFilename,
        mime_type:         mimeType,
        file_size:         fileSize,
        type:              fileType,
        chunk_index:       index,
        text,
        embedding_model:   EMBEDDING_MODEL,
        created_at:        new Date().toISOString(),
      },
    }));

    await qdrant.upsert(COLLECTION, { wait: true, points });
    await safeUnlink(tempPath);

    console.log(`[ingest] Upserted ${points.length} points (${EXPECTED_DENSE_SIZE}-dim) into "${COLLECTION}"`);

    res.json({
      ok:           true,
      document_id:  documentId,
      source,
      chunks:       chunks.length,
      embedding_model: EMBEDDING_MODEL,
      vector_size:  EXPECTED_DENSE_SIZE,
    });
  } catch (error) {
    console.error("[ingest] error:", error);
    await safeUnlink(tempPath);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /retrieve — hybrid search (OpenAI dense + TF sparse) fused via RRF
// ---------------------------------------------------------------------------
app.post("/retrieve", requireApiKey, async (req, res) => {
  try {
    const { query, topK = 10, source } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Missing query" });
    }

    // Embed query with the SAME model used during ingest
    const [denseVector] = await embedTexts([query]);
    const sparseVector  = buildSparseVector(query);

    // --- Validation ---
    if (!denseVector || denseVector.length === 0) {
      return res.status(500).json({
        error: "Embedding returned an empty vector — verify OPENAI_API_KEY",
      });
    }

    if (denseVector.length !== EXPECTED_DENSE_SIZE) {
      return res.status(500).json({
        error: `Vector dimension mismatch: expected ${EXPECTED_DENSE_SIZE}, got ${denseVector.length}. Re-index all documents with ${EMBEDDING_MODEL}.`,
      });
    }

    const filter = source
      ? { must: [{ key: "source", match: { value: source } }] }
      : undefined;

    const prefetchLimit = Math.max(20, topK * 4);

    const results = await qdrant.query(COLLECTION, {
      prefetch: [
        { query: denseVector, using: "dense",  limit: prefetchLimit, filter },
        { query: sparseVector, using: "sparse", limit: prefetchLimit, filter },
      ],
      query:        { fusion: "rrf" },
      limit:        topK,
      with_payload: true,
      filter,
    });

    const context = buildContext(results);

    res.json({
      query,
      topK,
      embedding_model: EMBEDDING_MODEL,
      vector_size:     EXPECTED_DENSE_SIZE,
      search_type:     "hybrid (dense OpenAI + sparse TF, RRF)",
      matches: results.map((r) => ({
        score:       r.score,
        source:      r.payload.source,
        chunk_index: r.payload.chunk_index,
        text:        r.payload.text,
      })),
      context,
    });
  } catch (error) {
    console.error("[retrieve] error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /documents/:documentId
// ---------------------------------------------------------------------------
app.delete("/documents/:documentId", requireApiKey, async (req, res) => {
  try {
    const { documentId } = req.params;

    await qdrant.delete(COLLECTION, {
      wait:   true,
      filter: { must: [{ key: "document_id", match: { value: documentId } }] },
    });

    console.log(`[delete] Removed all chunks for document_id: ${documentId}`);
    res.json({ ok: true, document_id: documentId });
  } catch (error) {
    console.error("[delete] error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /documents — list unique ingested documents
// ---------------------------------------------------------------------------
app.get("/documents", requireApiKey, async (req, res) => {
  try {
    const results = await qdrant.scroll(COLLECTION, {
      with_payload: ["document_id", "source", "original_filename", "type", "file_size", "embedding_model", "created_at"],
      with_vector:  false,
      limit:        1000,
    });

    const seen = new Map();
    for (const point of results.points) {
      const p = point.payload;
      if (!seen.has(p.document_id)) {
        seen.set(p.document_id, {
          document_id:       p.document_id,
          source:            p.source,
          original_filename: p.original_filename,
          type:              p.type,
          file_size:         p.file_size,
          embedding_model:   p.embedding_model ?? "unknown",
          created_at:        p.created_at,
        });
      }
    }

    res.json({ documents: Array.from(seen.values()) });
  } catch (error) {
    console.error("[documents] error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
app.listen(process.env.PORT || 3001, () => {
  console.log(`RAG service running on port ${process.env.PORT || 3001}`);
  console.log(`Embedding model : ${EMBEDDING_MODEL} (${EXPECTED_DENSE_SIZE} dims)`);
  console.log(`Qdrant URL      : ${process.env.QDRANT_URL}`);
  console.log(`Collection      : ${COLLECTION}`);
});
