// ---------------------------------------------------------------------------
// Sparse vector helpers — TF encoder with FNV-1a hashing trick.
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

export function buildSparseVector(text) {
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
