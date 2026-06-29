/**
 * Builds an enriched text for embedding a document chunk.
 * Combines keywords, summary, possible user queries, and the original text so
 * that a vague or short user query can still match the chunk semantically.
 */
export function buildEmbeddingText({ text, summary, keywords, search_queries }) {
  return [
    `Keywords:\n${keywords.join(", ")}`,
    `Summary:\n${summary}`,
    `Possible user queries:\n${search_queries.join("\n")}`,
    `Content:\n${text}`,
  ].join("\n\n");
}

/**
 * Builds an enriched text for embedding a user search query.
 * Adds an expanded version of the query and extracted keywords so that
 * vague or cross-language queries find the right chunks.
 */
export function buildSearchEmbeddingText(userQuery, { expanded_query, keywords }) {
  return [
    `Original question:\n${userQuery}`,
    `Expanded query:\n${expanded_query}`,
    `Keywords:\n${keywords.join(", ")}`,
  ].join("\n\n");
}

/**
 * Formats an array of Qdrant search matches into a numbered context block
 * suitable for inclusion in an LLM prompt.
 */
export function buildContext(matches) {
  return matches
    .map(
      (m, i) =>
        `SOURCE ${i + 1}\nsource: ${m.payload.source}\nchunk_index: ${m.payload.chunk_index}\nscore: ${m.score.toFixed(4)}\n\n${m.payload.text}`
    )
    .join("\n\n---\n\n");
}
