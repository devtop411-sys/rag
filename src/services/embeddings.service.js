import { EMBEDDING_MODEL } from "../config/constants.js";

/**
 * Calls the Voyage AI embeddings API and returns vectors in input order.
 * Used for BOTH document ingestion and query search — never mix models.
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts) {
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

  // Voyage AI batch responses are ordered by `index`; sort to be safe.
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}
