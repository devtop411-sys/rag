import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import { v4 as uuidv4 } from "uuid";
import { QdrantClient } from "@qdrant/js-client-rest";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
// ---------------------------------------------------------------------------
// Embedding model config — single source of truth
// Both ingest and query MUST use the same model and size.
// ---------------------------------------------------------------------------
const MODEL_DIMENSIONS = {
  "voyage-3.5":      1024,
  "voyage-3.5-lite":  512,
  "voyage-4":        1024,
  "voyage-4-lite":   1024,
};

const EMBEDDING_MODEL = process.env.VOYAGE_MODEL || "voyage-3.5";

if (!MODEL_DIMENSIONS[EMBEDDING_MODEL]) {
  console.warn(`[config] Unknown VOYAGE_MODEL "${EMBEDDING_MODEL}" — assuming 1024 dims. Update MODEL_DIMENSIONS if needed.`);
}

const EXPECTED_DENSE_SIZE = MODEL_DIMENSIONS[EMBEDDING_MODEL] ?? 1024;

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
// Meta-query tags — financial topics used to annotate each chunk.
// Stored in the Qdrant payload so Dify can filter/rank by topic.
// ---------------------------------------------------------------------------
const META_QUERY_TAGS = [
  "revenue","sales_growth","net_income","gross_profit","operating_profit",
  "ebit","ebitda","profit_margin","gross_margin","operating_margin",
  "cash_flow","operating_cash_flow","free_cash_flow","investing_cash_flow",
  "financing_cash_flow","capital_expenditure","working_capital","liquidity",
  "current_ratio","quick_ratio","debt","short_term_debt","long_term_debt",
  "interest_expense","leverage","credit_rating","assets","current_assets",
  "fixed_assets","inventory","accounts_receivable","accounts_payable",
  "equity","shareholders_equity","retained_earnings","dividends",
  "share_buybacks","earnings_per_share","valuation","market_cap",
  "enterprise_value","price_to_earnings","price_to_book","price_to_sales",
  "guidance","forecast","financial_targets","growth_strategy",
  "investment_strategy","mergers_acquisitions","acquisition","divestiture",
  "business_segments","geographic_revenue","customers","customer_concentration",
  "suppliers","competition","market_share","risk_factors","regulatory_risk",
  "legal_risk","cybersecurity_risk","operational_risk","liquidity_risk",
  "credit_risk","interest_rate_risk","foreign_exchange_risk","inflation_risk",
  "sustainability","esg","carbon_emissions","governance","executive_compensation",
  "board_of_directors","shareholder_meeting","tax","effective_tax_rate",
  "research_and_development","innovation","artificial_intelligence",
  "technology_investment","cloud_business","subscription_revenue",
  "recurring_revenue","cost_reduction","restructuring","layoffs","headcount",
  "employee_costs","earnings_call","quarterly_results","annual_report",
  "investor_relations",
];

const META_QUERY_TAG_SET = new Set(META_QUERY_TAGS);

// ---------------------------------------------------------------------------
// Concurrency limiter — runs `tasks` (thunks) at most `limit` at a time.
// ---------------------------------------------------------------------------
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  const executing = new Set();
  let idx = 0;

  async function runNext() {
    if (idx >= tasks.length) return;
    const i = idx++;
    const p = tasks[i]().then((r) => { results[i] = r; executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runNext));
  return results;
}

// ---------------------------------------------------------------------------
// Meta-query generation via OpenAI-compatible LLM.
// Returns an array of matched tags (subset of META_QUERY_TAGS).
// Skipped entirely when OPENAI_API_KEY is not set.
// ---------------------------------------------------------------------------
async function generateMetaQuery(chunkText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const baseUrl   = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model     = process.env.OPENAI_MODEL    || "gpt-4o-mini";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role:    "system",
          content: "You are a financial document analyst. Respond only with valid JSON.",
        },
        {
          role:    "user",
          content: `Analyze the financial document excerpt below and return a JSON object with a single key "tags" whose value is an array of relevant topic identifiers chosen ONLY from the allowed list. Select up to 15 tags that are directly discussed or referenced in the text. If nothing applies, return {"tags":[]}.

Allowed tags: ${META_QUERY_TAGS.join(", ")}

Text:
${chunkText}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[meta_query] LLM error (${response.status}): ${err}`);
    return [];
  }

  try {
    const data    = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed  = JSON.parse(content);
    const tags    = Array.isArray(parsed.tags) ? parsed.tags : [];
    const matched = tags.filter((t) => META_QUERY_TAG_SET.has(t));
    console.log(`[meta_query] chunk → ${matched.length} tags: ${matched.join(", ") || "(none)"}`);
    return matched;
  } catch (e) {
    console.error("[meta_query] Failed to parse LLM response:", e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const qdrant = new QdrantClient({
  url:    process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY || undefined,
});

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
// Embeddings — Voyage AI voyage-finance-2 (1024 dims)
// Used for BOTH document ingestion and query search — never mix models.
// ---------------------------------------------------------------------------
async function embedTexts(texts) {
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is not configured in .env");
  }

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Voyage AI embeddings error (${response.status}): ${errText}`);
  }

  const data = await response.json();

  // Voyage AI batch responses are ordered by `index`, sort to be safe
  return data.data
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
// Qdrant collection — single unnamed default vector (Voyage AI 1024 dims)
// Using unnamed vector so Dify's built-in Qdrant node can query it directly.
// Auto-migrates collections with wrong size or named-vector schema.
// ---------------------------------------------------------------------------
async function ensureCollection(denseSize) {
  const { collections } = await qdrant.getCollections();
  const exists = collections.some((c) => c.name === COLLECTION);

  if (exists) {
    const info        = await qdrant.getCollection(COLLECTION);
    const params      = info.config?.params?.vectors;
    // Unnamed default vector is stored directly as { size, distance } object
    const isUnnamed   = params && typeof params.size === "number";
    const currentSize = isUnnamed ? params.size : null;

    if (isUnnamed && currentSize === denseSize) {
      return; // Already correct — nothing to do
    }

    const reason = !isUnnamed
      ? "named-vector schema (incompatible with Dify Qdrant node)"
      : `vector size mismatch (${currentSize} → ${denseSize})`;

    console.log(`[ensureCollection] Recreating "${COLLECTION}": ${reason}`);
    await qdrant.deleteCollection(COLLECTION);
  }

  await qdrant.createCollection(COLLECTION, {
    vectors: { size: denseSize, distance: "Cosine" },
  });

  console.log(`[ensureCollection] Created "${COLLECTION}" (unnamed default vector, size=${denseSize}, Cosine)`);
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
// POST /ingest — parse, chunk, embed (Voyage AI), upsert unnamed default vectors
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

    // If the text uses markdown-style headers (# / ## / ###), split on each
    // header boundary first so every section becomes its own chunk.
    // Long sections are then further split by the character splitter.
    // Plain text (PDFs, no headers) goes straight to character splitting.
    const fallback = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
    let chunks;

    const looksLikeMarkdown = /^#{1,3} /m.test(rawText);
    if (looksLikeMarkdown) {
      const sections = rawText
        .split(/\n(?=#{1,3} )/)
        .map((s) => s.trim())
        .filter(Boolean);

      const parts = await Promise.all(
        sections.map((s) =>
          s.length > chunkSize ? fallback.splitText(s) : [s],
        ),
      );
      chunks = parts.flat().filter(Boolean);
    } else {
      chunks = await fallback.splitText(rawText);
    }

    if (!chunks.length) {
      await safeUnlink(tempPath);
      return res.status(400).json({ error: "No text chunks generated" });
    }

    console.log(`[ingest] "${source}" (${fileType}, ${fileSize} bytes) → ${chunks.length} chunks`);

    // Dense embeddings via Voyage AI → EXPECTED_DENSE_SIZE dims
    const denseEmbeddings = await embedTexts(chunks);

    // Validate returned vector size matches expected
    if (denseEmbeddings[0].length !== EXPECTED_DENSE_SIZE) {
      await safeUnlink(tempPath);
      return res.status(500).json({
        error: `Unexpected embedding size: got ${denseEmbeddings[0].length}, expected ${EXPECTED_DENSE_SIZE}`,
      });
    }

    // Meta-query tags — run LLM in parallel (5 concurrent) to label each chunk.
    // Falls back to [] per chunk when OPENAI_API_KEY is not configured.
    const metaQueryEnabled = !!process.env.OPENAI_API_KEY;
    let metaQueries = chunks.map(() => []);
    if (metaQueryEnabled) {
      console.log(`[ingest] Generating meta_query tags for ${chunks.length} chunks…`);
      metaQueries = await runWithConcurrency(
        chunks.map((text) => () => generateMetaQuery(text)),
        5,
      );
      const totalTags = metaQueries.reduce((s, t) => s + t.length, 0);
      console.log(`[ingest] meta_query done — ${totalTags} tags across ${chunks.length} chunks`);
    }

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
        meta_query:        metaQueries[index],
        embedding_model:   EMBEDDING_MODEL,
        created_at:        new Date().toISOString(),
      },
    }));

    await qdrant.upsert(COLLECTION, { wait: true, points });
    await safeUnlink(tempPath);

    console.log(`[ingest] Upserted ${points.length} points (${EXPECTED_DENSE_SIZE}-dim Voyage AI) into "${COLLECTION}"`);

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
});

// ---------------------------------------------------------------------------
// POST /search — meta_query-aware semantic search for Dify HTTP Request node
//
// Flow:
//   1. Embed the query via Voyage AI.
//   2. If `tags` are provided, run a filtered vector search (chunks whose
//      meta_query array contains ANY of the requested tags score higher).
//   3. If the filtered pass returns fewer than `min_results` hits, run an
//      unfiltered fallback and merge (deduped) so the LLM always has context.
//
// Body:  { query: string, tags?: string[], limit?: number, min_results?: number }
// Reply: { results: [{ text, source, chunk_index, score, meta_query }], used_tags: bool }
// ---------------------------------------------------------------------------
app.post("/search", requireApiKey, async (req, res) => {
  try {
    const { query, tags, limit = 5, min_results = 2 } = req.body;

    if (!query) return res.status(400).json({ error: "Missing query" });

    const [embedding] = await embedTexts([query]);

    const withPayload = ["text", "source", "chunk_index", "meta_query"];

    let results = [];
    let usedTags = false;

    // --- tag-filtered pass ---
    const validTags = Array.isArray(tags)
      ? tags.filter((t) => META_QUERY_TAG_SET.has(t))
      : [];

    if (validTags.length > 0) {
      const filtered = await qdrant.search(COLLECTION, {
        vector:       embedding,
        limit,
        with_payload: withPayload,
        filter: {
          must: [{ key: "meta_query", match: { any: validTags } }],
        },
      });
      results  = filtered;
      usedTags = true;
      console.log(`[search] tag-filtered (${validTags.join(", ")}) → ${filtered.length} hits`);
    }

    // --- fallback: unfiltered vector search when filtered pass is thin ---
    if (results.length < min_results) {
      const fallback = await qdrant.search(COLLECTION, {
        vector:       embedding,
        limit,
        with_payload: withPayload,
      });

      const seen = new Set(results.map((r) => r.id));
      for (const hit of fallback) {
        if (!seen.has(hit.id)) results.push(hit);
      }
      console.log(`[search] fallback unfiltered → total ${results.length} hits`);
    }

    const output = results.slice(0, limit).map((r) => ({
      text:        r.payload.text,
      source:      r.payload.source,
      chunk_index: r.payload.chunk_index,
      score:       r.score,
      meta_query:  r.payload.meta_query ?? [],
    }));

    res.json({ results: output, used_tags: usedTags });
  } catch (error) {
    console.error("[search] error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /retrieve — call Voyage AI, return embedding for Dify Qdrant node
// Dify workflow: HTTP REQUEST (/retrieve) → QDRANT VECTOR SEARCH → LLM → ANSWER
// The Qdrant node uses body.embedding as the query vector against the collection.
// Body:  { query: string }
// Reply: { embedding: number[], model: string, vector_size: number }
// ---------------------------------------------------------------------------
app.post("/retrieve", requireApiKey, async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Missing query" });
    }

    const [embedding] = await embedTexts([query]);

    if (!embedding || embedding.length === 0) {
      return res.status(500).json({
        error: "Voyage AI returned an empty vector — verify VOYAGE_API_KEY",
      });
    }

    console.log(`[retrieve] Embedded query (${embedding.length} dims) via ${EMBEDDING_MODEL}`);

    res.json({
      embedding,
      model:       EMBEDDING_MODEL,
      vector_size: EXPECTED_DENSE_SIZE,
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
// GET /health — unauthenticated liveness probe for Docker healthcheck
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/slack/events", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.send(body.challenge);
  }

  res.sendStatus(200);

  const event = body.event;

  if (!event || event.bot_id) return;
  if (event.type !== "app_mention" && event.type !== "message") return;

  const question = event.text.replace(/<@[^>]+>/g, "").trim();

  const difyResponse = await fetch("http://34.245.224.130/v1/chat-messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DIFY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: {},
      query: question,
      response_mode: "blocking",
      user: event.user,
    }),
  });

  const data = await difyResponse.json();

  await slack.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: data.answer || "No answer from Dify",
  });
});

// ---------------------------------------------------------------------------
app.listen(process.env.PORT || 3001, () => {
  console.log(`RAG service running on port ${process.env.PORT || 3001}`);
  console.log(`Embedding model : ${EMBEDDING_MODEL} (${EXPECTED_DENSE_SIZE} dims, Voyage AI)`);
  console.log(`Qdrant URL      : ${process.env.QDRANT_URL}`);
  console.log(`Collection      : ${COLLECTION}`);
});
