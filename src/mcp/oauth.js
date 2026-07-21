import { Router } from "express";
import express from "express";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

import { verifyGoogleCredential } from "../services/auth.service.js";
import { ALLOWED_DOMAIN } from "../config/constants.js";

// ---------------------------------------------------------------------------
// Self-hosted OAuth 2.1 authorization server for the remote MCP endpoint.
//
// This turns the Express backend into its own OAuth 2.1 Authorization Server so
// claude.ai (and any spec-compliant MCP client) can authenticate users before
// they reach /mcp. The actual "who are you" step is delegated to Google Sign-In
// and restricted to @collider.vc + the allow-list (see auth.service.js), so
// every external user logs in with their own identity.
//
// Flow (Authorization Code + PKCE, per the MCP authorization spec):
//   1. Unauthenticated /mcp call     → 401 + WWW-Authenticate (see mcpAuthGuard)
//   2. GET  /.well-known/oauth-protected-resource   → Protected Resource Meta
//   3. GET  /.well-known/oauth-authorization-server → AS metadata
//   4. POST /oauth/register          → Dynamic Client Registration (RFC 7591)
//   5. GET  /oauth/authorize         → Google Sign-In page
//   6. POST /oauth/consent           → verify Google creds, mint auth code
//   7. POST /oauth/token             → PKCE check, issue JWT access/refresh
//   8. /mcp with Bearer <jwt>        → verified per request
//
// Tokens are signed JWTs (HS256). No database is required: authorization codes
// are short-lived and kept in memory; clients are validated statelessly via the
// redirect-URI allow-list + PKCE, so nothing else needs to be persisted.
// ---------------------------------------------------------------------------

const ACCESS_TTL = Number(process.env.OAUTH_ACCESS_TTL || 3600); // seconds
const REFRESH_TTL = Number(process.env.OAUTH_REFRESH_TTL || 60 * 60 * 24 * 30);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// Signing key. Prefer a stable secret from the environment so tokens survive
// restarts and work across multiple instances. If none is set we generate an
// ephemeral one — auth is STILL enforced (secure by default), but tokens are
// invalidated on restart and won't validate across a multi-instance deploy.
let signingSecret = process.env.OAUTH_SIGNING_SECRET;
const EPHEMERAL_KEY = !signingSecret;
if (EPHEMERAL_KEY) {
  signingSecret = randomBytes(48).toString("base64url");
  console.warn(
    "[MCP OAuth] OAUTH_SIGNING_SECRET is not set — using an ephemeral signing key. " +
      "Tokens will be invalidated on restart and won't work across multiple instances. " +
      "Set OAUTH_SIGNING_SECRET in production.",
  );
}
if (!GOOGLE_CLIENT_ID) {
  console.warn(
    "[MCP OAuth] GOOGLE_CLIENT_ID is not set — the sign-in page cannot render the " +
      "Google button. Set GOOGLE_CLIENT_ID to enable login.",
  );
}
const SIGNING_KEY = new TextEncoder().encode(signingSecret);

// ---------------------------------------------------------------------------
// Base URL / resource identity
//
// Metadata and token audiences must be absolute URLs. Prefer PUBLIC_BASE_URL
// (e.g. https://rag.collider.vc); otherwise derive from proxy headers.
//
// Behind TLS-terminating proxies (Cloudflare / ALB / nginx on :80) the
// X-Forwarded-Proto header is often "http" even though clients reach us over
// HTTPS. Claude refuses OAuth against http:// endpoints, so for any non-local
// host we upgrade to https.
// ---------------------------------------------------------------------------
export function getBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || "").trim();
  if (configured) {
    // Even an explicit PUBLIC_BASE_URL must be https for public hosts —
    // Claude refuses OAuth discovery over http://.
    try {
      const u = new URL(configured.replace(/\/+$/, ""));
      const host = u.hostname.toLowerCase();
      const isLocal =
        host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!isLocal && u.protocol === "http:") u.protocol = "https:";
      return u.origin;
    } catch {
      return configured.replace(/\/+$/, "");
    }
  }

  const host = String(
    req.headers["x-forwarded-host"] || req.headers["host"] || "localhost",
  )
    .split(",")[0]
    .trim();
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  const isLocal =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local");

  let proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim()
    .toLowerCase();

  // Public hosts must advertise https — otherwise Claude DCR fails.
  if (!isLocal && proto !== "https") proto = "https";

  return `${proto}://${host}`;
}

const resourceOf = (baseUrl) => `${baseUrl}/mcp`;

// ---------------------------------------------------------------------------
// Redirect-URI allow-list. Prevents auth-code interception via open redirect.
// claude.ai / claude.com callbacks are always allowed; localhost is allowed for
// local testing (e.g. the MCP Inspector); extras via OAUTH_EXTRA_REDIRECT_URIS.
// ---------------------------------------------------------------------------
const ALLOWED_REDIRECTS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);
for (const uri of (process.env.OAUTH_EXTRA_REDIRECT_URIS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)) {
  ALLOWED_REDIRECTS.add(uri);
}

function isAllowedRedirect(uri) {
  if (!uri || typeof uri !== "string") return false;
  if (ALLOWED_REDIRECTS.has(uri)) return true;
  try {
    const u = new URL(uri);
    // Claude Code uses http://localhost:<ephemeral>/callback (port varies).
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return u.pathname === "/callback" || u.pathname === "/";
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Authorization codes — signed JWTs (stateless).
//
// Previously stored in memory, which breaks when /oauth/consent and
// /oauth/token hit different processes (restarts, multiple containers).
// A short-lived signed JWT carries the PKCE binding and user identity.
// ---------------------------------------------------------------------------
const AUTH_CODE_TTL = "2m";
const usedAuthCodeJtis = new Map(); // jti → expiry ms (best-effort single-use)

function pruneUsedAuthCodes() {
  const now = Date.now();
  for (const [jti, exp] of usedAuthCodeJtis) {
    if (exp < now) usedAuthCodeJtis.delete(jti);
  }
}

async function mintAuthCode(payload) {
  return new SignJWT({ ...payload, token_type: "auth_code" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(AUTH_CODE_TTL)
    .setJti(randomUUID())
    .sign(SIGNING_KEY);
}

async function consumeAuthCode(code) {
  const { payload } = await jwtVerify(code, SIGNING_KEY);
  if (payload.token_type !== "auth_code") {
    throw new Error("not an authorization code");
  }
  pruneUsedAuthCodes();
  const jti = payload.jti;
  if (!jti || usedAuthCodeJtis.has(jti)) {
    throw new Error("authorization code already used");
  }
  // Mark used for slightly longer than the code TTL.
  usedAuthCodeJtis.set(jti, Date.now() + 5 * 60_000);
  return payload;
}

// ---------------------------------------------------------------------------
// PKCE (S256 only, as required by OAuth 2.1)
// ---------------------------------------------------------------------------
function verifyPkce(codeVerifier, codeChallenge) {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(String(codeChallenge));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Token issuing / verification
// ---------------------------------------------------------------------------
export async function issueAccessToken({ sub, name, picture, scope, baseUrl }) {
  return new SignJWT({ name, picture, scope, token_type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(baseUrl)
    .setAudience(resourceOf(baseUrl))
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL}s`)
    .setJti(randomUUID())
    .sign(SIGNING_KEY);
}

async function issueRefreshToken({ sub, name, picture, scope, baseUrl }) {
  return new SignJWT({ name, picture, scope, token_type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(baseUrl)
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TTL}s`)
    .setJti(randomUUID())
    .sign(SIGNING_KEY);
}

export async function verifyAccessToken(token, baseUrl) {
  const { payload } = await jwtVerify(token, SIGNING_KEY, {
    issuer: baseUrl,
    audience: resourceOf(baseUrl),
  });
  if (payload.token_type !== "access") {
    throw new Error("not an access token");
  }
  return payload;
}

async function buildTokenResponse({ sub, name, picture, scope, baseUrl }) {
  const [access_token, refresh_token] = await Promise.all([
    issueAccessToken({ sub, name, picture, scope, baseUrl }),
    issueRefreshToken({ sub, name, picture, scope, baseUrl }),
  ]);
  return {
    access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token,
    scope,
  };
}

// ---------------------------------------------------------------------------
// /mcp bearer-token guard.
//
// On a missing/invalid token it returns 401 with a WWW-Authenticate header
// pointing at the Protected Resource Metadata — the breadcrumb Claude follows
// to start the OAuth flow.
// ---------------------------------------------------------------------------
export function mcpAuthGuard(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] || "");
  if (!match) return sendChallenge(req, res);

  verifyAccessToken(match[1].trim(), getBaseUrl(req))
    .then((payload) => {
      req.mcpUser = { email: payload.sub, name: payload.name };
      next();
    })
    .catch(() => sendChallenge(req, res, "invalid_token"));
}

function sendChallenge(req, res, error) {
  const prm = `${getBaseUrl(req)}/.well-known/oauth-protected-resource`;
  let header = `Bearer resource_metadata="${prm}"`;
  if (error) header += `, error="${error}"`;
  res.set("WWW-Authenticate", header);
  return res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: authentication required" },
    id: null,
  });
}

// ---------------------------------------------------------------------------
// Router: metadata + OAuth endpoints
// ---------------------------------------------------------------------------
export const oauthRouter = Router();
oauthRouter.use(express.urlencoded({ extended: true })); // token endpoint is form-encoded

// --- Protected Resource Metadata (RFC 9728) ---
function protectedResourceMetadata(req, res) {
  const base = getBaseUrl(req);
  res.json({
    resource: resourceOf(base),
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
}
oauthRouter.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
oauthRouter.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

// --- Authorization Server Metadata (RFC 8414) ---
function authServerMetadata(req, res) {
  const base = getBaseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
}
oauthRouter.get("/.well-known/oauth-authorization-server", authServerMetadata);
oauthRouter.get("/.well-known/openid-configuration", authServerMetadata);

// --- Dynamic Client Registration (RFC 7591) ---
// Stateless: we issue an opaque client_id and rely on the redirect-URI
// allow-list + PKCE for security, so registrations don't need to be persisted.
oauthRouter.post("/oauth/register", (req, res) => {
  const body = req.body || {};
  const redirectUris = body.redirect_uris;
  console.log("[MCP OAuth register]", JSON.stringify(req.body, null, 2));
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "redirect_uris is required",
    });
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirect(uri)) {
      return res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: `redirect_uri not allowed: ${uri}`,
      });
    }
  }

  return res.status(201).json({
    client_id: randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: body.client_name || "MCP Client",
    scope: "mcp",
  });
});

// --- Authorization endpoint: renders the Google Sign-In page ---
oauthRouter.get("/oauth/authorize", (req, res) => {
  const {
    response_type,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    scope,
    resource,
  } = req.query;

  const errors = [];
  if (response_type !== "code") errors.push("response_type must be 'code'");
  if (!client_id) errors.push("client_id is required");
  if (!isAllowedRedirect(String(redirect_uri || "")))
    errors.push("redirect_uri is missing or not allowed");
  if (!code_challenge) errors.push("code_challenge is required (PKCE)");
  if (code_challenge_method !== "S256")
    errors.push("code_challenge_method must be 'S256'");

  if (errors.length) {
    return res.status(400).type("html").send(renderErrorPage(errors));
  }

  res.type("html").send(
    renderAuthorizePage({
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      scope,
      resource,
    }),
  );
});

// --- Consent: verify the Google credential and mint an authorization code ---
oauthRouter.post("/oauth/consent", express.json(), async (req, res) => {
  try {
    const {
      credential,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      scope,
      resource,
    } = req.body || {};

    if (!credential) {
      return res.status(400).json({ error: "invalid_request", error_description: "missing credential" });
    }
    if (!isAllowedRedirect(redirect_uri)) {
      return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not allowed" });
    }
    if (!code_challenge || code_challenge_method !== "S256") {
      return res.status(400).json({ error: "invalid_request", error_description: "PKCE (S256) required" });
    }

    // Throws with .status 401/403 on invalid token / disallowed account.
    const user = await verifyGoogleCredential(credential);

    const code = await mintAuthCode({
      email: user.email,
      name: user.name,
      picture: user.picture,
      client_id,
      redirect_uri,
      code_challenge,
      resource: resource || resourceOf(getBaseUrl(req)),
      scope: scope || "mcp",
    });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    console.log(`[MCP OAuth] authorized ${user.email} → redirect`);
    return res.json({ redirect_url: url.toString() });
  } catch (err) {
    const status = err.status ?? 500;
    console.warn(`[MCP OAuth] consent failed: ${err.message}`);
    return res.status(status).json({
      error: status === 403 ? "access_denied" : "invalid_grant",
      error_description: err.message,
    });
  }
});

// --- Token endpoint ---
oauthRouter.post("/oauth/token", async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const grantType = req.body?.grant_type;

  try {
    if (grantType === "authorization_code") {
      const { code, code_verifier, redirect_uri } = req.body;

      let entry;
      try {
        entry = await consumeAuthCode(code);
      } catch (err) {
        console.warn(`[MCP OAuth] token exchange: bad code — ${err.message}`);
        return tokenError(res, "invalid_grant", "authorization code invalid or expired");
      }

      if (entry.redirect_uri !== redirect_uri) {
        return tokenError(res, "invalid_grant", "redirect_uri mismatch");
      }
      if (!verifyPkce(code_verifier, entry.code_challenge)) {
        return tokenError(res, "invalid_grant", "PKCE verification failed");
      }

      console.log(`[MCP OAuth] token issued for ${entry.email}`);
      return res.json(
        await buildTokenResponse({
          sub: entry.email,
          name: entry.name,
          picture: entry.picture,
          scope: entry.scope || "mcp",
          baseUrl,
        }),
      );
    }

    if (grantType === "refresh_token") {
      const { refresh_token } = req.body;
      let payload;
      try {
        ({ payload } = await jwtVerify(refresh_token, SIGNING_KEY, { issuer: baseUrl }));
      } catch {
        return tokenError(res, "invalid_grant", "invalid refresh token");
      }
      if (payload.token_type !== "refresh") {
        return tokenError(res, "invalid_grant", "not a refresh token");
      }
      return res.json(
        await buildTokenResponse({
          sub: payload.sub,
          name: payload.name,
          picture: payload.picture,
          scope: payload.scope || "mcp",
          baseUrl,
        }),
      );
    }

    return tokenError(res, "unsupported_grant_type", `unsupported grant_type: ${grantType}`);
  } catch (err) {
    return tokenError(res, "server_error", err.message);
  }
});

function tokenError(res, error, error_description) {
  return res.status(400).json({ error, error_description });
}

// ---------------------------------------------------------------------------
// HTML rendering (minimal, self-contained)
// ---------------------------------------------------------------------------
function renderAuthorizePage(params) {
  // Values are injected only as a JSON blob consumed by JS (never interpolated
  // into HTML/attributes), so there is no injection surface from query params.
  const paramsJson = JSON.stringify(params).replace(/</g, "\\u003c");
  const clientIdAttr = String(GOOGLE_CLIENT_ID).replace(/"/g, "&quot;");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Collider RAG MCP</title>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0b0d12; color: #e7e9ee;
  }
  .card {
    width: min(92vw, 380px); padding: 32px 28px; border-radius: 16px;
    background: #151a23; border: 1px solid #232a36;
    box-shadow: 0 20px 50px rgba(0,0,0,.4); text-align: center;
  }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { font-size: 13.5px; color: #9aa4b2; margin: 0 0 22px; line-height: 1.5; }
  .btnwrap { display: flex; justify-content: center; min-height: 44px; }
  .status { margin-top: 16px; font-size: 13px; min-height: 18px; }
  .status.err { color: #ff8080; }
  .foot { margin-top: 22px; font-size: 11.5px; color: #5f6b7d; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect to Collider RAG</h1>
    <p>Sign in with your <strong>@${ALLOWED_DOMAIN}</strong> Google account to authorize this MCP connection.</p>
    <div class="btnwrap">
      <div id="g_id_onload"
           data-client_id="${clientIdAttr}"
           data-callback="onCredential"
           data-auto_prompt="false"></div>
      <div class="g_id_signin" data-type="standard" data-theme="filled_blue"
           data-size="large" data-text="signin_with" data-shape="pill"></div>
    </div>
    <div id="status" class="status"></div>
    <div class="foot">Access is restricted to authorized accounts.</div>
  </div>
<script>
  const OAUTH_PARAMS = ${paramsJson};
  const statusEl = document.getElementById("status");
  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = "status" + (isError ? " err" : "");
  }
  async function onCredential(response) {
    setStatus("Authorizing…", false);
    try {
      const res = await fetch(window.location.origin + "/oauth/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: response.credential, ...OAUTH_PARAMS }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.error_description || data.error || "Authorization failed.", true);
        return;
      }
      window.location.href = data.redirect_url;
    } catch (err) {
      setStatus("Network error: " + err.message, true);
    }
  }
  window.onCredential = onCredential;
</script>
</body>
</html>`;
}

function renderErrorPage(errors) {
  const items = errors
    .map((e) => `<li>${String(e).replace(/</g, "&lt;")}</li>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Authorization error</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0b0d12; color:#e7e9ee;
    min-height:100vh; display:grid; place-items:center; margin:0; }
  .card { width:min(92vw,420px); padding:28px; border-radius:14px;
    background:#151a23; border:1px solid #232a36; }
  h1 { font-size:17px; margin:0 0 12px; color:#ff8080; }
  ul { margin:0; padding-left:18px; font-size:13.5px; color:#c3cad6; line-height:1.7; }
</style></head>
<body><div class="card"><h1>Invalid authorization request</h1><ul>${items}</ul></div></body></html>`;
}
