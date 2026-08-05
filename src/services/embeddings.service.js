import { EMBEDDING_MODEL } from "../config/constants.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";


const MAX_RPM = Number(process.env.VOYAGE_MAX_RPM) || 3;
const MAX_TPM = Number(process.env.VOYAGE_MAX_TPM) || 10_000;

const REQUEST_TOKEN_BUDGET = Math.max(1000, Math.floor(MAX_TPM * 0.9));
const MAX_TEXTS_PER_REQUEST = 128; // Voyage batch cap
const MAX_RETRIES = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


function estimateTokens(text) {
  return Math.max(1, Math.ceil((text?.length || 0) / 3.5));
}


const recent = [];

async function acquire(tokens) {
  for (;;) {
    const now = Date.now();
    while (recent.length && recent[0].at <= now - 60_000) recent.shift();

    const tokenSum = recent.reduce((s, e) => s + e.tokens, 0);
    const rpmOk = recent.length < MAX_RPM;

    const tpmOk = tokenSum + Math.min(tokens, MAX_TPM) <= MAX_TPM;

    if (rpmOk && tpmOk) {
      recent.push({ at: now, tokens });
      return;
    }

    const oldest = recent[0]?.at ?? now;
    const waitMs = Math.max(250, oldest + 60_000 - now + 50);
    await sleep(waitMs);
  }
}

async function embedBatch(texts, estTokens) {
  let attempt = 0;
  for (;;) {
    await acquire(estTokens);

    const response = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });

    if (response.ok) {
      const data = await response.json();
      // Voyage batch responses are ordered by `index`; sort to be safe.
      return data.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    }

    const errText = await response.text();

    // Retry on rate limit (429) and transient server errors (5xx).
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      attempt += 1;
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 1000 * 2 ** attempt);
      console.warn(
        `[voyage] ${response.status} rate-limited — retry ${attempt}/${MAX_RETRIES} in ${Math.round(backoff / 1000)}s`,
      );
      await sleep(backoff);
      continue;
    }

    throw new Error(`Voyage AI embeddings error (${response.status}): ${errText}`);
  }
}

/**
 * Calls the Voyage AI embeddings API and returns vectors in input order.
 * Used for BOTH document ingestion and query search — never mix models.
 *
 * Automatically batches inputs under the per-request token budget and
 * self-throttles to the configured RPM/TPM so it works on the free tier.
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts) {
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is not configured in .env");
  }
  if (!Array.isArray(texts) || texts.length === 0) return [];

  // Split into batches that respect the token budget and batch-size cap.
  const batches = [];
  let cur = [];
  let curTokens = 0;

  for (const text of texts) {
    const t = estimateTokens(text);
    if (
      cur.length &&
      (curTokens + t > REQUEST_TOKEN_BUDGET || cur.length >= MAX_TEXTS_PER_REQUEST)
    ) {
      batches.push({ texts: cur, tokens: curTokens });
      cur = [];
      curTokens = 0;
    }
    cur.push(text);
    curTokens += t;
  }
  if (cur.length) batches.push({ texts: cur, tokens: curTokens });

  const out = [];
  for (const batch of batches) {
    const vectors = await embedBatch(batch.texts, batch.tokens);
    out.push(...vectors);
  }
  return out;
}
