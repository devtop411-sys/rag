import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import app from "../src/app.js";
import { issueAccessToken } from "../src/mcp/oauth.js";

// ---------------------------------------------------------------------------
// Integration tests for the Streamable HTTP MCP endpoint mounted on the main
// Express backend. These exercise the transport + connectivity tools
// (hello / tools/list), the OAuth 2.1 metadata endpoints, and the bearer-token
// auth guard. They require no external services (Qdrant/Voyage/Google).
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let accessToken;

const POST_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test-client", version: "1.0.0" },
  },
};

function postMcp(body, sessionId, token = accessToken) {
  const headers = { ...POST_HEADERS };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// Runs initialize + the initialized notification, returning a live session ID.
async function openSession() {
  const initRes = await postMcp(INITIALIZE_BODY);
  const sessionId = initRes.headers.get("mcp-session-id");
  await initRes.json(); // drain body
  await postMcp(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  return sessionId;
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  // Mint a token exactly as the /oauth/token endpoint would for this base URL.
  accessToken = await issueAccessToken({
    sub: "tester@collider.vc",
    name: "Tester",
    scope: "mcp",
    baseUrl,
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("initialize returns a session ID and server info", async () => {
  const res = await postMcp(INITIALIZE_BODY);
  assert.equal(res.status, 200);

  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId, "expected an mcp-session-id response header");

  const json = await res.json();
  assert.equal(json.jsonrpc, "2.0");
  assert.equal(json.id, 1);
  assert.ok(json.result, "expected a result object");
  assert.equal(json.result.serverInfo.name, "rag-knowledge-base");
  assert.ok(json.result.protocolVersion, "expected a negotiated protocol version");
});

test("initialize succeeds with Accept: */* (Claude connector compatibility)", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(INITIALIZE_BODY),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("mcp-session-id"), "expected a session ID");
  const json = await res.json();
  assert.equal(json.result.serverInfo.name, "rag-knowledge-base");
});

test("tools/list exposes the hello and search_knowledge_base tools", async () => {
  const sessionId = await openSession();

  const res = await postMcp(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
  );
  assert.equal(res.status, 200);

  const json = await res.json();
  const names = json.result.tools.map((t) => t.name);
  assert.ok(names.includes("hello"), "expected a 'hello' tool");
  assert.ok(
    names.includes("search_knowledge_base"),
    "expected a 'search_knowledge_base' tool",
  );
});

test("hello tool returns the confirmation message", async () => {
  const sessionId = await openSession();

  const res = await postMcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "hello", arguments: {} },
    },
    sessionId,
  );
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(
    json.result.content[0].text,
    "Hello, Claude! Collider MCP server is working.",
  );
});

test("a request with an invalid session ID is rejected with 400", async () => {
  const res = await postMcp(
    { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
    "non-existent-session-id",
  );
  assert.equal(res.status, 400);
});

test("GET /mcp without a session ID is rejected with 400", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// OAuth 2.1 auth guard + discovery
// ---------------------------------------------------------------------------

test("POST /mcp without a bearer token is rejected with 401 + WWW-Authenticate", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: POST_HEADERS,
    body: JSON.stringify(INITIALIZE_BODY),
  });
  assert.equal(res.status, 401);
  const header = res.headers.get("www-authenticate") || "";
  assert.match(header, /Bearer/);
  assert.match(header, /resource_metadata=/);
  assert.match(header, /\/\.well-known\/oauth-protected-resource/);
});

test("POST /mcp with an invalid bearer token is rejected with 401", async () => {
  const res = await postMcp(INITIALIZE_BODY, undefined, "not-a-real-token");
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /error="invalid_token"/);
});

test("protected resource metadata advertises this server as its own auth server", async () => {
  const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.resource, `${baseUrl}/mcp`);
  assert.ok(Array.isArray(json.authorization_servers));
  assert.ok(json.authorization_servers.includes(baseUrl));
});

test("authorization server metadata exposes PKCE + the OAuth endpoints", async () => {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.issuer, baseUrl);
  assert.equal(json.authorization_endpoint, `${baseUrl}/oauth/authorize`);
  assert.equal(json.token_endpoint, `${baseUrl}/oauth/token`);
  assert.equal(json.registration_endpoint, `${baseUrl}/oauth/register`);
  assert.ok(json.code_challenge_methods_supported.includes("S256"));
});

test("metadata upgrades http → https for public Host headers (proxy safety)", async () => {
  // Simulate a TLS-terminating proxy that forwards as plain http with a public Host.
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
    headers: {
      Host: "rag.collider.vc",
      "X-Forwarded-Proto": "http",
      "X-Forwarded-Host": "rag.collider.vc",
    },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.issuer, "https://rag.collider.vc");
  assert.match(json.registration_endpoint, /^https:\/\//);
});

test("dynamic client registration rejects a disallowed redirect_uri", async () => {
  const res = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example.com/callback"] }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error, "invalid_redirect_uri");
});

test("dynamic client registration accepts the Claude callback", async () => {
  const res = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
    }),
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.ok(json.client_id, "expected a client_id");
  assert.equal(json.token_endpoint_auth_method, "none");
});

test("authorize rejects a request without PKCE", async () => {
  const url =
    `${baseUrl}/oauth/authorize?response_type=code` +
    `&client_id=abc&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}`;
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 400);
});
