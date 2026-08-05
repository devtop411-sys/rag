import { EMBEDDING_MODEL } from "../config/constants.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";


const MAX_RPM = Number(process.env.VOYAGE_MAX_RPM) || 3;
const MAX_TPM = Number(process.env.VOYAGE_MAX_TPM) || 10_000;

const EFFECTIVE_TPM = Math.max(1000, Math.floor(MAX_TPM * 0.85));
const REQUEST_TOKEN_BUDGET = EFFECTIVE_TPM; // max tokens per single request
const MAX_TEXTS_PER_REQUEST = 128; // Voyage batch cap
const MAX_RETRIES = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rough token estimate (Voyage ≈ 4 chars/token; dividing by 3.5 over-counts
// slightly so we stay conservatively below the real limit).
function estimateTokens(text) {
  return Math.max(1, Math.ceil((text?.length || 0) / 3.5));
}


let chain = Promise.resolve();
let lastStartAt = 0;

function schedule(tokens) {
  const run = chain.then(async () => {
    const rpmGap = 60_000 / MAX_RPM;
    const tpmGap = (Math.min(tokens, EFFECTIVE_TPM) / EFFECTIVE_TPM) * 60_000;
    const gap = Math.max(rpmGap, tpmGap);
    const wait = lastStartAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastStartAt = Date.now();
  });
  chain = run.catch(() => {}); // keep the chain alive regardless of outcome
  return run;
}

async function embedBatch(texts, estTokens) {
  let attempt = 0;
  for (;;) {
    // Every attempt (initial + retries) passes through the spacing gate.
    await schedule(estTokens);

    let response;
    try {
      response = await fetch(VOYAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        attempt += 1;
        console.warn(`[voyage] network error — retry ${attempt}/${MAX_RETRIES}: ${err.message}`);
        continue;
      }
      throw err;
    }

    if (response.ok) {
      const data = await response.json();
      // Voyage batch responses are ordered by `index`; sort to be safe.
      return data.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    }

    const errText = await response.text();

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      attempt += 1;
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
      console.warn(
        `[voyage] ${response.status} rate-limited — retry ${attempt}/${MAX_RETRIES} (auto-spaced ~${Math.round(60 / MAX_RPM)}s)`,
      );
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
