import { qdrant } from "./qdrant.service.js";
import {
  DRIVE_STATE_COLLECTION,
  DRIVE_DEFAULT_SETTINGS,
  DRIVE_DEFAULT_WATCH_FOLDER,
} from "../config/constants.js";

const CONNECTION_ID = "00000000-0000-4000-8000-000000000002";
const DUMMY_VECTOR  = [1];

const EXPIRY_SKEW_MS = 60 * 1000;

let ensured = false;

async function ensureStateCollection() {
  if (ensured) return;

  try {
    await qdrant.getCollection(DRIVE_STATE_COLLECTION);
  } catch (err) {
    const is404 =
      err.message === "Not Found" || err.$metadata?.httpStatusCode === 404;
    if (!is404) throw err;

    await qdrant.createCollection(DRIVE_STATE_COLLECTION, {
      vectors: { size: 1, distance: "Cosine" },
    });
    console.log(`[drive] Created state collection "${DRIVE_STATE_COLLECTION}"`);
  }

  ensured = true;
}

function emptyConnection() {
  return {
    access_token:     "",
    token_expires_at: null,
    status:           "disconnected",
    account:          null,
    watch_folder:     { ...DRIVE_DEFAULT_WATCH_FOLDER },
    last_synced_at:   null,
    unusable_files:   [],
    auto_sync:        { ...DRIVE_DEFAULT_SETTINGS },
  };
}

export function hasLiveToken(conn) {
  if (!conn?.access_token || !conn.token_expires_at) return false;
  const expiresAt = Date.parse(conn.token_expires_at);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt - EXPIRY_SKEW_MS;
}

export async function getConnection() {
  try {
    await ensureStateCollection();
    const points = await qdrant.retrieve(DRIVE_STATE_COLLECTION, {
      ids: [CONNECTION_ID],
      with_payload: true,
      with_vector: false,
    });
    const payload = points?.[0]?.payload;
    if (payload) {
      return {
        access_token:     payload.access_token || "",
        token_expires_at: payload.token_expires_at || null,
        status:           payload.status || "disconnected",
        account:          payload.account || null,
        watch_folder:     payload.watch_folder || { ...DRIVE_DEFAULT_WATCH_FOLDER },
        last_synced_at:   payload.last_synced_at || null,
        unusable_files:   payload.unusable_files || [],
        auto_sync:        { ...DRIVE_DEFAULT_SETTINGS, ...(payload.auto_sync || {}) },
      };
    }
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    console.error(
      `[drive] getConnection failed (Qdrant ${process.env.QDRANT_URL}): ${err.message}${code ? ` (${code})` : ""}`
    );
  }

  return emptyConnection();
}

export async function saveConnection(patch) {
  await ensureStateCollection();
  const current = await getConnection();
  const next = {
    ...current,
    ...patch,
    auto_sync:    { ...current.auto_sync, ...(patch.auto_sync || {}) },
    watch_folder: patch.watch_folder ?? current.watch_folder,
  };

  await qdrant.upsert(DRIVE_STATE_COLLECTION, {
    wait: true,
    points: [{ id: CONNECTION_ID, vector: DUMMY_VECTOR, payload: next }],
  });

  return next;
}


export function saveAccessToken({ accessToken, expiresIn, account }) {
  const ttl = Math.max(60, Number(expiresIn) || 3600);
  return saveConnection({
    access_token:     accessToken,
    token_expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    status:           "connected",
    ...(account ? { account } : {}),
  });
}

export function clearAccessToken() {
  return saveConnection({
    access_token:     "",
    token_expires_at: null,
    status:           "disconnected",
    account:          null,
  });
}

/**
 * Returns the stored browser token for server-side Drive calls.
 *
 * @throws 401 when no unexpired token is stored, so callers can ask the user to
 *   reopen the Drive page and reconnect.
 */
export async function getAccessToken() {
  const conn = await getConnection();
  if (!hasLiveToken(conn)) {
    const err = new Error(
      "Google Drive authorization has expired. Open the Google Drive page to reconnect."
    );
    err.status = 401;
    throw err;
  }
  return conn.access_token;
}

export function publicConnection(conn) {
  return {
    connected:        hasLiveToken(conn),
    status:           conn.status,
    account:          conn.account,
    watch_folder:     conn.watch_folder,
    last_synced_at:   conn.last_synced_at,
    token_expires_at: conn.token_expires_at,
    unusable_count:   (conn.unusable_files ?? []).length,
    auto_sync:        conn.auto_sync,
  };
}
