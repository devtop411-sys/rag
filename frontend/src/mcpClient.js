const STORAGE_KEY = "collider_mcp_oauth";
const PKCE_KEY = "collider_mcp_pkce";
const PROTOCOL_VERSION = "2025-06-18";

const exchangingCodes = new Set();

function b64url(buf) {
  let s = "";
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1eyJhbG...REDACTED")
      .replace(
        /("(access_token|refresh_token|code|credential|id_token)"\s*:\s*")[^"]+/gi,
        '$1…REDACTED',
      );
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|credential|authorization|cookie/i.test(k)) {
        out[k] = typeof v === "string" && v ? `${String(v).slice(0, 8)}…REDACTED` : "REDACTED";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

export async function createPkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: b64url(digest) };
}

export function getMcpRedirectUri() {
  const { hostname, origin } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${origin}/callback`;
  }
  return `${origin}/mcp-oauth-callback`;
}

export function loadMcpAuth() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function saveMcpAuth(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function clearMcpAuth() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PKCE_KEY);
}

export function savePkcePending(data) {
  localStorage.setItem(PKCE_KEY, JSON.stringify(data));
}

export function peekPkcePending() {
  const raw = localStorage.getItem(PKCE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearPkcePending() {
  localStorage.removeItem(PKCE_KEY);
}

export function originFromMcpUrl(mcpUrl) {
  return new URL(mcpUrl, window.location.origin).origin;
}

export async function discoverOAuth(mcpUrl) {
  const origin = originFromMcpUrl(mcpUrl);
  const prmRes = await fetch(`${origin}/.well-known/oauth-protected-resource`);
  if (!prmRes.ok) {
    throw new Error(
      `OAuth discovery failed — Unable to load ${origin}/.well-known/oauth-protected-resource (HTTP ${prmRes.status})`,
    );
  }
  const prm = await prmRes.json();

  const asRes = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  if (!asRes.ok) {
    throw new Error(
      `OAuth discovery failed — Unable to load authorization server metadata (HTTP ${asRes.status})`,
    );
  }
  const asMeta = await asRes.json();
  return { prm, asMeta, origin };
}

export async function registerOAuthClient(mcpUrl) {
  const origin = originFromMcpUrl(mcpUrl);
  const redirectUri = getMcpRedirectUri();
  const res = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "Collider MCP Playground",
      token_endpoint_auth_method: "none",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `OAuth client registration failed — POST /oauth/register returned HTTP ${res.status}: ${
        json.error_description || json.error || "unknown error"
      }`,
    );
  }
  return { ...json, redirect_uri: redirectUri };
}

export function buildAuthorizeUrl(mcpUrl, { clientId, redirectUri, challenge, state }) {
  const origin = originFromMcpUrl(mcpUrl);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "mcp",
    resource: new URL(mcpUrl, window.location.origin).href,
  });
  return `${origin}/oauth/authorize?${q}`;
}

export async function startOAuthRedirect(mcpUrl) {
  await discoverOAuth(mcpUrl);
  const { verifier, challenge } = await createPkce();
  const client = await registerOAuthClient(mcpUrl);
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = client.redirect_uri || getMcpRedirectUri();
  savePkcePending({
    verifier,
    state,
    mcpUrl,
    clientId: client.client_id,
    redirectUri,
  });
  window.location.href = buildAuthorizeUrl(mcpUrl, {
    clientId: client.client_id,
    redirectUri,
    challenge,
    state,
  });
}

export async function exchangeCode(mcpUrl, { code, verifier, redirectUri, clientId }) {
  if (exchangingCodes.has(code)) {
    throw new Error("Token exchange already in progress for this authorization code");
  }
  exchangingCodes.add(code);

  const origin = originFromMcpUrl(mcpUrl);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    resource: new URL(mcpUrl, window.location.origin).href,
  });

  try {
    const res = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Token exchange failed — POST /oauth/token returned HTTP ${res.status}: ${
          json.error_description || json.error || "unknown error"
        }`,
      );
    }
    return json;
  } finally {
    // Keep code marked briefly so a Strict Mode remount cannot replay it.
    setTimeout(() => exchangingCodes.delete(code), 15_000);
  }
}

export async function refreshAccessToken(mcpUrl, refreshToken) {
  const origin = originFromMcpUrl(mcpUrl);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `refresh ${res.status}`);
  }
  return json;
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function userFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  return {
    email: payload.sub || payload.email || null,
    name: payload.name || null,
  };
}

export class McpSession {
  constructor(mcpUrl, accessToken, onLog) {
    this.mcpUrl = mcpUrl;
    this.accessToken = accessToken;
    this.sessionId = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.onLog = onLog || (() => {});
    this._id = 0;
  }

  nextId() {
    this._id += 1;
    return this._id;
  }

  log(entry) {
    this.onLog({
      ts: new Date().toLocaleTimeString("en-GB", { hour12: false }),
      ...entry,
    });
  }

  async request(body, { notification = false } = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.accessToken}`,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const method = body.method || "request";
    const started = performance.now();
    const res = await fetch(this.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const durationMs = Math.round(performance.now() - started);

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const responseHeaders = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = /authorization/i.test(k) ? "REDACTED" : v;
    });

    if (notification) {
      this.log({
        method: `POST /mcp`,
        detail: `${method} → ${res.status}`,
        ok: res.ok,
        status: res.status,
        durationMs,
        request: redactSecrets({ headers: { ...headers, Authorization: "Bearer eyJhbG...REDACTED" }, body }),
        response: { status: res.status, headers: responseHeaders, body: null },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      this.log({ method, detail: "OK", ok: true, durationMs });
      return null;
    }

    const json = await res.json().catch(() => null);
    this.log({
      method: `POST /mcp`,
      detail: `${method} → ${res.status}`,
      ok: res.ok && !json?.error,
      status: res.status,
      durationMs,
      request: redactSecrets({
        headers: { ...headers, Authorization: "Bearer eyJhbG...REDACTED" },
        body,
      }),
      response: redactSecrets({ status: res.status, headers: responseHeaders, body: json }),
    });

    if (!res.ok) {
      const msg =
        json?.error?.message || json?.error_description || `HTTP ${res.status}`;
      this.log({ method, detail: msg, ok: false, status: res.status, durationMs });
      if (res.status === 401) {
        throw new Error("MCP authentication failed — The MCP server rejected the access token.");
      }
      throw new Error(msg);
    }
    if (json?.error) {
      this.log({ method, detail: json.error.message || "RPC error", ok: false, durationMs });
      throw new Error(json.error.message || "RPC error");
    }
    this.log({ method, detail: "OK", ok: true, durationMs });
    return json?.result;
  }

  async initialize() {
    const result = await this.request({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "rag-collider-mcp-playground", version: "1.0.0" },
      },
    });
    this.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
    this.serverInfo = result?.serverInfo || null;
    this.capabilities = result?.capabilities || null;
    await this.request(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { notification: true },
    );
    return result;
  }

  async listTools() {
    return this.request({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/list",
      params: {},
    });
  }

  async callTool(name, args) {
    this.log({ method: `tools/call → ${name}`, detail: "…", ok: true });
    return this.request({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: { name, arguments: args },
    });
  }
}

export { PROTOCOL_VERSION };
