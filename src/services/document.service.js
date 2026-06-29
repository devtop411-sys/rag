import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { META_QUERY_TAGS, META_QUERY_TAG_SET } from "../config/constants.js";

// ---------------------------------------------------------------------------
// Binary stream → Buffer
// ---------------------------------------------------------------------------
export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Extract raw text from a buffer based on file extension
// ---------------------------------------------------------------------------
export async function extractText(buffer, ext) {
  switch (ext) {
    case ".pdf": {
      const parsed = await pdfParse(buffer);
      return parsed.text;
    }
    case ".docx": {
      const { value } = await mammoth.extractRawText({ buffer });
      return value;
    }
    case ".txt":
    case ".md":
      return buffer.toString("utf8");
    default:
      throw new Error(`Unsupported file type "${ext}"`);
  }
}

// ---------------------------------------------------------------------------
// Meta-query generation via OpenAI-compatible LLM.
// Returns an array of matched tags (subset of META_QUERY_TAGS).
// Skipped entirely when OPENAI_API_KEY is not set.
// ---------------------------------------------------------------------------
export async function generateMetaQuery(chunkText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model   = process.env.OPENAI_MODEL    || "gpt-4o-mini";

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
// Chunk-level metadata generation via LLM.
// Returns summary, keywords, and example search queries for a chunk.
// Used to enrich the embedding text and improve retrieval for vague queries.
// Skipped entirely when OPENAI_API_KEY is not set.
// ---------------------------------------------------------------------------
export async function generateChunkMetadata(chunkText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model   = process.env.OPENAI_MODEL    || "gpt-4o-mini";

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
          content: "You are generating search metadata for a RAG system. Respond only with valid JSON.",
        },
        {
          role:    "user",
          content: `Given this document chunk, generate:
1. A short summary of what it is about
2. Keywords (include synonyms, both specific and general terms)
3. Possible user search queries (how users may ask about this content)

Rules:
- Return only valid JSON
- Keep everything in English
- Do not invent facts outside the chunk

Chunk:
${chunkText}

Return JSON:
{
  "summary": "",
  "keywords": [],
  "search_queries": []
}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[chunk_metadata] LLM error (${response.status}): ${err}`);
    return null;
  }

  try {
    const data    = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed  = JSON.parse(content);
    const summary  = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.filter((k) => typeof k === "string") : [];
    const search_queries = Array.isArray(parsed.search_queries) ? parsed.search_queries.filter((q) => typeof q === "string") : [];
    console.log(`[chunk_metadata] summary="${summary.slice(0, 60)}…", ${keywords.length} keywords, ${search_queries.length} queries`);
    return { summary, keywords, search_queries };
  } catch (e) {
    console.error("[chunk_metadata] Failed to parse LLM response:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Query expansion via LLM.
// Returns an expanded/clarified version of the user query plus keywords.
// Used to enrich the search embedding for better retrieval of vague queries.
// Skipped entirely when OPENAI_API_KEY is not set.
// ---------------------------------------------------------------------------
export async function generateSearchQueryMetadata(userQuery) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model   = process.env.OPENAI_MODEL    || "gpt-4o-mini";

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
          content: "You are improving a user query for semantic search in a RAG system. Respond only with valid JSON.",
        },
        {
          role:    "user",
          content: `User query:
${userQuery}

Generate:
1. expanded_query — a clearer, more complete version of the query
2. keywords — important terms and synonyms (always in English)

Rules:
- Return only valid JSON
- Keep the original meaning; do not answer the question
- Do not invent unrelated topics

Return JSON:
{
  "expanded_query": "",
  "keywords": []
}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[query_metadata] LLM error (${response.status}): ${err}`);
    return null;
  }

  try {
    const data    = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed  = JSON.parse(content);
    const expanded_query = typeof parsed.expanded_query === "string" ? parsed.expanded_query.trim() : userQuery;
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.filter((k) => typeof k === "string") : [];
    console.log(`[query_metadata] expanded="${expanded_query.slice(0, 80)}…", ${keywords.length} keywords`);
    return { expanded_query, keywords };
  } catch (e) {
    console.error("[query_metadata] Failed to parse LLM response:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document-level metadata extraction via LLM (author + date).
// Called only when the caller did not supply these fields explicitly AND
// auto-extraction from file metadata came up empty.
// ---------------------------------------------------------------------------
export async function extractDocumentMeta(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { author: null, date: null };

  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model   = process.env.OPENAI_MODEL    || "gpt-4o-mini";
  const snippet = text.slice(0, 3000);

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
          content: "You are a document metadata extractor. Respond only with valid JSON.",
        },
        {
          role:    "user",
          content: `Extract the author name and publication/document date from the excerpt below.
Return JSON with exactly two keys:
  "author": full name string, or null if not found
  "date":   ISO date string YYYY-MM-DD, or null if not found
Only return values you are confident about.

Document excerpt:
${snippet}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    console.warn(`[meta/doc] LLM error (${response.status}) — skipping author/date extraction`);
    return { author: null, date: null };
  }

  try {
    const data    = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed  = JSON.parse(content);
    const author  =
      typeof parsed.author === "string" && parsed.author.trim()
        ? parsed.author.trim()
        : null;
    const date    =
      typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : null;
    console.log(`[meta/doc] Extracted → author="${author ?? "(none)"}", date="${date ?? "(none)"}"`);
    return { author, date };
  } catch (e) {
    console.error("[meta/doc] Failed to parse LLM response:", e.message);
    return { author: null, date: null };
  }
}
