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
