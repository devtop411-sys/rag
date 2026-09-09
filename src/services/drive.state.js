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
const AUTH_URL      = "https://accounts.google.com/o/oauth2/v2/auth";
const EXPIRY_SKEW_MS = 60 * 1000;

export const DRIVE_OAUTH_CALLBACK_PATH = "/drive";
export const DRIVE_OAUTH_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const STATIC_DRIVE_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8080",
  "https://rag.collider.vc",
  "https://dev.rag.collider.vc",
];

function publicOrigin() {
  const pub = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!pub) return "";
  try {
    return new URL(pub).origin;
  } catch {
    return pub;
  }
}

export function allowedDriveOrigins() {
  const origins = new Set(STATIC_DRIVE_ORIGINS);
  const pub = publicOrigin();
  if (pub) origins.add(pub);
  return origins;
}

/**
 * Google requires the token-exchange redirect_uri to match the authorize URL
 * exactly. Default is PUBLIC_BASE_URL/drive (or localhost in dev).
 */
export function resolveDriveRedirectUri(requested) {
  const fallbackOrigin = publicOrigin() || "http://localhost:5173";
  const fallback = `${fallbackOrigin}${DRIVE_OAUTH_CALLBACK_PATH}`;
  if (!requested) return fallback;

  let url;
  try {
    url = new URL(requested);
  } catch {
    const err = new Error("Invalid redirect_uri");
    err.status = 400;
    throw err;
  }

  if (url.pathname !== DRIVE_OAUTH_CALLBACK_PATH || url.search || url.hash) {
    const err = new Error("redirect_uri must be the Drive page (origin + /drive)");
    err.status = 400;
    throw err;
  }

  if (!allowedDriveOrigins().has(url.origin)) {
    const err = new Error(`redirect_uri origin is not allowed: ${url.origin}`);
    err.status = 400;
    throw err;
  }

  return `${url.origin}${DRIVE_OAUTH_CALLBACK_PATH}`;
}

export function buildDriveAuthorizeUrl({ redirectUri, state } = {}) {
  requireOAuthClient();
  const resolved = resolveDriveRedirectUri(redirectUri);
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  resolved,
    response_type: "code",
    scope:         DRIVE_OAUTH_SCOPE,
    access_type:   "offline",
    include_granted_scopes: "true",
  });
  if (state) params.set("state", String(state));
  // Google ignores `prompt=select_account+consent` (URLSearchParams encoding)
  // and then silently uses the Chrome profile account. Force %20 so the
  // account picker always appears, including "Use another account".
  const qs = `${params.toString()}&prompt=select_account%20consent`;
  return { url: `${AUTH_URL}?${qs}`, redirect_uri: resolved };
}

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
      "Google Drive needs the Client Secret of the same Web client used to sign in " +
      `(GOOGLE_CLIENT_ID). Login does not use a secret; Drive does. ` +
      `Open that client in Google Cloud Console and copy its Client secret into GOOGLE_CLIENT_SECRET.`
    );
    err.status = 500;
    throw err;
  }
}

function fetchErrorMessage(err) {
  const cause = err?.cause;
  return cause?.code || cause?.message || err?.message || "fetch failed";
}

async function tokenRequest(body) {
  requireOAuthClient();
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const wrapped = new Error(`Could not reach Google OAuth: ${fetchErrorMessage(err)}`);
    wrapped.status = 502;
    throw wrapped;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    const invalidSecret = /invalid.?client|invalid.?secret|Unauthorized/i.test(msg);
    const err = new Error(
      invalidSecret
        ? "The client secret does not match GOOGLE_CLIENT_ID. Open that same Web client in Google Cloud Console, copy its current Client secret into GitHub secret GOOGLE_CLIENT_SECRET (not the MCP client), then re-run the Deploy workflow."
        : `Google OAuth token error: ${msg}`
    );
    err.status = res.status === 401 || res.status === 400 ? 401 : 502;
    throw err;
  }
  return data;
}

/**
 * Exchange an authorization code (from the /drive redirect) for tokens.
 * Requires access_type=offline + consent so Google returns a refresh_token.
 */
export async function exchangeCodeForTokens(code, redirectUri) {
  const data = await tokenRequest({
    code,
    client_id:     GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri:  resolveDriveRedirectUri(redirectUri),
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
