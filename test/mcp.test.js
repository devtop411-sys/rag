import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import app from "../src/app.js";

// ---------------------------------------------------------------------------
// Integration tests for the Streamable HTTP MCP endpoint mounted on the main
// Express backend. These exercise only the transport + connectivity tools
// (hello / tools/list) and require no external services (Qdrant/Voyage).
// ---------------------------------------------------------------------------

let server;
let baseUrl;

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

function postMcp(body, sessionId) {
  const headers = { ...POST_HEADERS };
  if (sessionId) headers["mcp-session-id"] = sessionId;
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
    headers: { Accept: "text/event-stream" },
  });
  assert.equal(res.status, 400);
});
