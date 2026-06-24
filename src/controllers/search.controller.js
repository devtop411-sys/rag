import {
  META_QUERY_TAG_SET,
  COLLECTION,
  EMBEDDING_MODEL,
  EXPECTED_DENSE_SIZE,
} from "../config/constants.js";
import { embedTexts } from "../services/embeddings.service.js";
import { qdrant } from "../services/qdrant.service.js";

const PAYLOAD_FIELDS = ["text", "source", "chunk_index", "meta_query", "author", "document_date"];

// ---------------------------------------------------------------------------
// POST /search — meta_query-aware semantic search
//
// Flow:
//   1. Embed the query via Voyage AI.
//   2. If `tags` are provided, run a filtered vector search (chunks whose
//      meta_query array contains ANY of the requested tags score higher).
//   3. If the filtered pass returns fewer than `min_results` hits, run an
//      unfiltered fallback and merge (deduped) so the LLM always has context.
//
// Body:  { query, tags?, limit?, min_results? }
// ---------------------------------------------------------------------------
export async function search(req, res) {
  try {
    const { query, tags, limit = 5, min_results = 2 } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });

    const [embedding] = await embedTexts([query]);

    let results  = [];
    let usedTags = false;

    const validTags = Array.isArray(tags)
      ? tags.filter((t) => META_QUERY_TAG_SET.has(t))
      : [];

    if (validTags.length > 0) {
      const filtered = await qdrant.search(COLLECTION, {
        vector:       embedding,
        limit,
        with_payload: PAYLOAD_FIELDS,
        filter: {
          must: [{ key: "meta_query", match: { any: validTags } }],
        },
      });
      results  = filtered;
      usedTags = true;
      console.log(`[search] tag-filtered (${validTags.join(", ")}) → ${filtered.length} hits`);
    }

    if (results.length < min_results) {
      const fallback = await qdrant.search(COLLECTION, {
        vector:       embedding,
        limit,
        with_payload: PAYLOAD_FIELDS,
      });
      const seen = new Set(results.map((r) => r.id));
      for (const hit of fallback) {
        if (!seen.has(hit.id)) results.push(hit);
      }
      console.log(`[search] fallback unfiltered → total ${results.length} hits`);
    }

    const output = results.slice(0, limit).map((r) => ({
      text:          r.payload.text,
      source:        r.payload.source,
      chunk_index:   r.payload.chunk_index,
      score:         r.score,
      meta_query:    r.payload.meta_query    ?? [],
      author:        r.payload.author        ?? null,
      document_date: r.payload.document_date ?? null,
    }));

    res.json({ results: output, used_tags: usedTags });
  } catch (error) {
    console.error("[search] error:", error);
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// POST /retrieve — embed query and return the raw vector for Dify Qdrant node
// Body:  { query }
// ---------------------------------------------------------------------------
export async function retrieve(req, res) {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });

    const [embedding] = await embedTexts([query]);

    if (!embedding || embedding.length === 0) {
      return res.status(500).json({
        error: "Voyage AI returned an empty vector — verify VOYAGE_API_KEY",
      });
    }

    console.log(`[retrieve] Embedded query (${embedding.length} dims) via ${EMBEDDING_MODEL}`);
    res.json({ embedding, model: EMBEDDING_MODEL, vector_size: EXPECTED_DENSE_SIZE });
  } catch (error) {
    console.error("[retrieve] error:", error);
    res.status(500).json({ error: error.message });
  }
}
