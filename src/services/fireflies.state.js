import { qdrant } from "./qdrant.service.js";
import {
  FIREFLIES_STATE_COLLECTION,
  FIREFLIES_API_KEY,
  FIREFLIES_DEFAULT_SETTINGS,
} from "../config/constants.js";

const CONNECTION_ID = "00000000-0000-4000-8000-000000000001";
const DUMMY_VECTOR = [1];

let ensured = false;

export async function ensureStateCollection() {
  if (ensured) return;

  try {
    await qdrant.getCollection(FIREFLIES_STATE_COLLECTION);
  } catch (err) {
    const is404 =
      err.message === "Not Found" || err.$metadata?.httpStatusCode === 404;
    if (!is404) throw err;

    await qdrant.createCollection(FIREFLIES_STATE_COLLECTION, {
      vectors: { size: 1, distance: "Cosine" },
    });
    console.log(
      `[fireflies] Created state collection "${FIREFLIES_STATE_COLLECTION}"`
    );
  }

  ensured = true;
}

export async function getConnection() {
  try {
    await ensureStateCollection();
    const points = await qdrant.retrieve(FIREFLIES_STATE_COLLECTION, {
      ids: [CONNECTION_ID],
      with_payload: true,
      with_vector: false,
    });
    const payload = points?.[0]?.payload;
    if (payload) {
      return {
        api_key:        payload.api_key || "",
        status:         payload.status || "disconnected",
        account:        payload.account || null,
        last_synced_at: payload.last_synced_at || null,
        auto_sync:      { ...FIREFLIES_DEFAULT_SETTINGS, ...(payload.auto_sync || {}) },
      };
    }
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    console.error(
      `[fireflies] getConnection failed (Qdrant ${process.env.QDRANT_URL}): ${err.message}${code ? ` (${code})` : ""}`
    );
  }

  return {
    api_key:        FIREFLIES_API_KEY,
    status:         FIREFLIES_API_KEY ? "connected" : "disconnected",
    account:        null,
    last_synced_at: null,
    auto_sync:      { ...FIREFLIES_DEFAULT_SETTINGS },
  };
}

export async function saveConnection(patch) {
  await ensureStateCollection();
  const current = await getConnection();
  const next = {
    ...current,
    ...patch,
    auto_sync: { ...current.auto_sync, ...(patch.auto_sync || {}) },
  };

  await qdrant.upsert(FIREFLIES_STATE_COLLECTION, {
    wait: true,
    points: [{ id: CONNECTION_ID, vector: DUMMY_VECTOR, payload: next }],
  });

  return next;
}

export async function getApiKey() {
  const conn = await getConnection();
  return conn.api_key || FIREFLIES_API_KEY || "";
}
