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

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
// Qdrant client
// ---------------------------------------------------------------------------
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY || undefined,
});

// ---------------------------------------------------------------------------
// API key middleware — protects /ingest, /retrieve, /documents/*
// Skip check if API_KEY is not configured (dev mode)
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
// Helpers
// ---------------------------------------------------------------------------
async function embedTexts(texts, inputType) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: "voyage-3",
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Voyage embedding error: ${err}`);
  }

  const json = await res.json();
  return json.data.map((item) => item.embedding);
}

async function ensureCollection(vectorSize) {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION);

  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: vectorSize, distance: "Cosine" },
    });
    console.log(`Created Qdrant collection: ${COLLECTION}`);
  }
}

function buildContext(matches) {
  return matches
    .map((m, i) => {
      return `SOURCE ${i + 1}
source: ${m.payload.source}
chunk_index: ${m.payload.chunk_index}
score: ${m.score}

${m.payload.text}`;
    })
    .join("\n\n---\n\n");
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore — file may already be deleted
  }
}

// ---------------------------------------------------------------------------
// POST /ingest — admin file upload
// ---------------------------------------------------------------------------
app.post("/ingest", requireApiKey, upload.single("file"), async (req, res) => {
  const tempPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file" });
    }

    // File type validation
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      await safeUnlink(tempPath);
      return res.status(400).json({
        error: `Unsupported file type "${ext}". Allowed: .pdf, .txt, .md`,
      });
    }

    const source           = req.body.source || req.file.originalname;
    const chunkSize        = parseInt(req.body.chunkSize)   || 1200;
    const chunkOverlap     = parseInt(req.body.chunkOverlap) || 250;
    const originalFilename = req.file.originalname;
    const fileSize         = req.file.size;
    const mimeType         = MIME_MAP[ext] ?? "application/octet-stream";
    const fileType         = ext === ".pdf" ? "pdf" : "text";

    const buffer = await fs.readFile(tempPath);

    // Parse: try PDF, fall back to UTF-8 text
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

    console.log(`Ingesting "${source}" (${fileType}, ${fileSize} bytes) — ${chunks.length} chunks`);

    const embeddings = await embedTexts(chunks, "document");
    await ensureCollection(embeddings[0].length);

    const documentId = uuidv4();

    const points = chunks.map((text, index) => ({
      id: uuidv4(),
      vector: embeddings[index],
      payload: {
        document_id:       documentId,
        source,
        original_filename: originalFilename,
        mime_type:         mimeType,
        file_size:         fileSize,
        type:              fileType,
        chunk_index:       index,
        text,
        created_at:        new Date().toISOString(),
      },
    }));

    await qdrant.upsert(COLLECTION, { wait: true, points });
    await safeUnlink(tempPath);

    res.json({ ok: true, document_id: documentId, source, chunks: chunks.length });
  } catch (error) {
    console.error(error);
    await safeUnlink(tempPath);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /retrieve — semantic search
// ---------------------------------------------------------------------------
app.post("/retrieve", requireApiKey, async (req, res) => {
  try {
    const { query, topK = 5, source } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Missing query" });
    }

    const [queryVector] = await embedTexts([query], "query");

    const filter = source
      ? { must: [{ key: "source", match: { value: source } }] }
      : undefined;

    const results = await qdrant.search(COLLECTION, {
      vector: queryVector,
      limit: topK,
      with_payload: true,
      filter,
    });

    const context = buildContext(results);

    res.json({
      query,
      topK,
      matches: results.map((r) => ({
        score:       r.score,
        source:      r.payload.source,
        chunk_index: r.payload.chunk_index,
        text:        r.payload.text,
      })),
      context,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /documents/:documentId — remove all chunks for a document
// ---------------------------------------------------------------------------
app.delete("/documents/:documentId", requireApiKey, async (req, res) => {
  try {
    const { documentId } = req.params;

    await qdrant.delete(COLLECTION, {
      wait: true,
      filter: {
        must: [{ key: "document_id", match: { value: documentId } }],
      },
    });

    console.log(`Deleted all chunks for document_id: ${documentId}`);
    res.json({ ok: true, document_id: documentId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /documents — list all unique documents in the collection
// ---------------------------------------------------------------------------
app.get("/documents", requireApiKey, async (req, res) => {
  try {
    const results = await qdrant.scroll(COLLECTION, {
      with_payload: ["document_id", "source", "original_filename", "type", "file_size", "created_at"],
      with_vector:  false,
      limit:        1000,
    });

    // Deduplicate by document_id (one entry per document)
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
          created_at:        p.created_at,
        });
      }
    }

    res.json({ documents: Array.from(seen.values()) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
app.listen(process.env.PORT || 3001, () => {
  console.log(`RAG service running on port ${process.env.PORT || 3001}`);
});
