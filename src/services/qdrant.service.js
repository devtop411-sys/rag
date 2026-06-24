import { QdrantClient } from "@qdrant/js-client-rest";
import { COLLECTION } from "../config/constants.js";

export const qdrant = new QdrantClient({
  url:                process.env.QDRANT_URL,
  apiKey:             process.env.QDRANT_API_KEY || undefined,
  checkCompatibility: false,
});

/**
 * Ensures the Qdrant collection exists with an unnamed default vector of
 * `denseSize` dimensions (Cosine distance).
 *
 * Auto-migrates collections that have the wrong vector size or use a
 * named-vector schema (incompatible with the Dify Qdrant node).
 *
 * @param {number} denseSize
 */
export async function ensureCollection(denseSize) {
  let exists = false;
  let currentSize = null;
  let isUnnamed = false;

  try {
    const info   = await qdrant.getCollection(COLLECTION);
    const params = info.config?.params?.vectors;
    isUnnamed    = params && typeof params.size === "number";
    currentSize  = isUnnamed ? params.size : null;
    exists       = true;
  } catch (err) {
    const is404 = err.message === "Not Found" || err.$metadata?.httpStatusCode === 404;
    if (!is404) throw err;
  }

  if (exists) {
    if (isUnnamed && currentSize === denseSize) return;

    const reason = !isUnnamed
      ? "named-vector schema (incompatible with Dify Qdrant node)"
      : `vector size mismatch (${currentSize} → ${denseSize})`;

    console.log(`[ensureCollection] Recreating "${COLLECTION}": ${reason}`);
    await qdrant.deleteCollection(COLLECTION);
  }

  await qdrant.createCollection(COLLECTION, {
    vectors: { size: denseSize, distance: "Cosine" },
  });

  console.log(
    `[ensureCollection] Created "${COLLECTION}" (unnamed default vector, size=${denseSize}, Cosine)`
  );
}
