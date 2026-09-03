import { qdrant } from "./qdrant.service.js";
import {
  DRIVE_STATE_COLLECTION,
  DRIVE_DEFAULT_SETTINGS,
  DRIVE_DEFAULT_WATCH_FOLDERS,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} from "../config/constants.js";

const CONNECTION_ID = "00000000-0000-4000-8000-000000000002";
const DUMMY_VECTOR  = [1];
const TOKEN_URL     = "https://oauth2.googleapis.com/token";
const EXPIRY_SKEW_MS = 60 * 1000;

export const DRIVE_OAUTH_REDIRECT_URI = "postmessage";

let ensured = false;
let refreshInFlight = null;

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
    refresh_token:    "",
    access_token:     "",
    token_expires_at: null,
    status:           "disconnected",
    account:          null,
    watch_folders:    DRIVE_DEFAULT_WATCH_FOLDERS.map((f) => ({ ...f })),
    last_synced_at:   null,
    unusable_files:   [],
    auto_sync:        { ...DRIVE_DEFAULT_SETTINGS },
  };
}

function readWatchFolders(payload) {
  if (Array.isArray(payload.watch_folders)) return payload.watch_folders;
  if (payload.watch_folder) return [payload.watch_folder];
  return DRIVE_DEFAULT_WATCH_FOLDERS.map((f) => ({ ...f }));
}

function readAutoSync(payload) {
  const auto = { ...DRIVE_DEFAULT_SETTINGS, ...(payload.auto_sync || {}) };
  if (!Number.isFinite(+auto.frequency_minutes) || auto.frequency_minutes < 60) {
    auto.frequency_minutes = DRIVE_DEFAULT_SETTINGS.frequency_minutes;
  }
  return auto;
}

function hasFreshAccessToken(conn) {
  if (!conn?.access_token || !conn.token_expires_at) return false;
  const expiresAt = Date.parse(conn.token_expires_at);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt - EXPIRY_SKEW_MS;
}

/** Connected when we have a refresh token (or a still-valid legacy access token). */
export function isConnected(conn) {
  if (conn?.refresh_token) return true;
  return hasFreshAccessToken(conn);
}

/** @deprecated use isConnected — kept for call-site compatibility */
export function hasLiveToken(conn) {
  return isConnected(conn);
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
        refresh_token:    payload.refresh_token || "",
        access_token:     payload.access_token || "",
        token_expires_at: payload.token_expires_at || null,
        status:           payload.status || "disconnected",
        account:          payload.account || null,
        watch_folders:    readWatchFolders(payload),
        last_synced_at:   payload.last_synced_at || null,
        unusable_files:   payload.unusable_files || [],
        auto_sync:        readAutoSync(payload),
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
    auto_sync:     { ...current.auto_sync, ...(patch.auto_sync || {}) },
    watch_folders: patch.watch_folders ?? current.watch_folders,
  };
  delete next.watch_folder;

  await qdrant.upsert(DRIVE_STATE_COLLECTION, {
    wait: true,
    points: [{ id: CONNECTION_ID, vector: DUMMY_VECTOR, payload: next }],
  });

  return next;
}

function requireOAuthClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    const err = new Error(
      "Google Drive OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET " +
      "(or MCP_GOOGLE_CLIENT_ID / MCP_GOOGLE_CLIENT_SECRET)."
    );
    err.status = 500;
    throw err;
  }
}

async function tokenRequest(body) {
  requireOAuthClient();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    const err = new Error(`Google OAuth token error: ${msg}`);
    err.status = res.status === 401 || res.status === 400 ? 401 : 502;
    throw err;
  }
  return data;
}

/**
 * Exchange an authorization code (from the browser GIS popup) for tokens.
 * Requires access_type=offline + consent so Google returns a refresh_token.
 */
export async function exchangeCodeForTokens(code) {
  const data = await tokenRequest({
    code,
    client_id:     GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri:  DRIVE_OAUTH_REDIRECT_URI,
    grant_type:    "authorization_code",
  });

  if (!data.access_token) {
    const err = new Error("Google did not return an access token");
    err.status = 502;
    throw err;
  }

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || "",
    expires_in:    Number(data.expires_in) || 3600,
    scope:         data.scope || "",
  };
}

async function refreshWithToken(refreshToken) {
  const data = await tokenRequest({
    refresh_token: refreshToken,
    client_id:     GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type:    "refresh_token",
  });

  return {
    access_token: data.access_token,
    expires_in:   Number(data.expires_in) || 3600,
    refresh_token: data.refresh_token || "",
  };
}

export async function saveOAuthTokens({
  accessToken,
  refreshToken,
  expiresIn,
  account,
}) {
  const current = await getConnection();
  const ttl = Math.max(60, Number(expiresIn) || 3600);
  const nextRefresh = refreshToken || current.refresh_token || "";

  return saveConnection({
    access_token:     accessToken,
    refresh_token:    nextRefresh,
    token_expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    status:           nextRefresh || accessToken ? "connected" : "disconnected",
    ...(account ? { account } : {}),
  });
}

export async function clearAccessToken() {
  return saveConnection({
    refresh_token:    "",
    access_token:     "",
    token_expires_at: null,
    status:           "disconnected",
    account:          null,
  });
}

/**
 * Returns a usable access token, refreshing via the stored refresh_token when needed.
 */
export async function getAccessToken() {
  const conn = await getConnection();

  if (hasFreshAccessToken(conn)) {
    return conn.access_token;
  }

  if (!conn.refresh_token) {
    const err = new Error(
      "Google Drive is not connected. Open the Google Drive page and connect once."
    );
    err.status = 401;
    throw err;
  }

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const tokens = await refreshWithToken(conn.refresh_token);
        await saveOAuthTokens({
          accessToken:  tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn:    tokens.expires_in,
        });
        return tokens.access_token;
      } catch (err) {
        if (err.status === 401) {
          await saveConnection({
            access_token:     "",
            token_expires_at: null,
            status:           "disconnected",
          });
        }
        throw err;
      } finally {
        refreshInFlight = null;
      }
    })();
  }

  return refreshInFlight;
}

export function publicConnection(conn) {
  return {
    connected:        isConnected(conn),
    status:           isConnected(conn) ? "connected" : (conn.status || "disconnected"),
    account:          conn.account,
    watch_folders:    conn.watch_folders,
    last_synced_at:   conn.last_synced_at,
    token_expires_at: conn.token_expires_at,
    unusable_count:   (conn.unusable_files ?? []).length,
    auto_sync:        conn.auto_sync,
    has_refresh_token: Boolean(conn.refresh_token),
  };
}
