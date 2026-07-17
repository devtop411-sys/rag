import { Router } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "./server.js";
import { mcpAuthGuard } from "./oauth.js";

// ---------------------------------------------------------------------------
// Streamable HTTP MCP transport, mounted on the EXISTING Express backend.
//
//   POST   /mcp  → JSON-RPC requests (initialize + all subsequent calls)
//   GET    /mcp  → server-initiated SSE stream (requires a live session)
//   DELETE /mcp  → terminate a session
//
// Stateful mode: the server issues an `Mcp-Session-Id` on initialize and keeps
// one transport per session in memory. This is what Claude Custom Connectors
// expect from a remote Streamable HTTP MCP server.
//
// Logging is intentionally minimal and safe — only session IDs and lifecycle
// events are logged. Never log auth tokens, AWS/Qdrant credentials, or env.
// ---------------------------------------------------------------------------

const transports = new Map(); // sessionId → StreamableHTTPServerTransport

export const mcpRouter = Router();

// ---------------------------------------------------------------------------
// Accept-header compatibility shim.
//
// The MCP SDK requires the Accept header to literally list BOTH
// `application/json` and `text/event-stream`. Some clients — notably the
// Claude Custom Connectors broker — send `Accept: */*` (or omit it), which the
// SDK would otherwise reject with 406 before initialize ever succeeds.
//
// We normalize it here (both the parsed header and rawHeaders, since the Node
// transport rebuilds the request via @hono/node-server) so those clients can
// connect. Scoped to /mcp only — it never touches other API routes.
// ---------------------------------------------------------------------------
function normalizeMcpAccept(req, _res, next) {
  const desired = "application/json, text/event-stream";
  const accept = req.headers["accept"] || "";
  const compatible =
    accept.includes("application/json") && accept.includes("text/event-stream");

  if (!compatible) {
    req.headers["accept"] = desired;
    if (Array.isArray(req.rawHeaders)) {
      let patched = false;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (String(req.rawHeaders[i]).toLowerCase() === "accept") {
          req.rawHeaders[i + 1] = desired;
          patched = true;
        }
      }
      if (!patched) req.rawHeaders.push("Accept", desired);
    }
  }
  next();
}

mcpRouter.use("/mcp", normalizeMcpAccept);

// Require a valid OAuth 2.1 bearer token for every /mcp method (POST/GET/DELETE).
// Unauthenticated requests get a 401 + WWW-Authenticate pointing at the
// Protected Resource Metadata, which is how Claude discovers the OAuth flow.
mcpRouter.use("/mcp", mcpAuthGuard);

mcpRouter.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — reuse its transport.
      transport = transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session — spin up a fresh server + transport pair.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          console.log(`[MCP] session initialized: ${sid}`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports.has(sid)) {
          transports.delete(sid);
          console.log(`[MCP] session closed: ${sid}`);
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
      console.log("[MCP] initialize request — new server connected");
    } else {
      console.warn("[MCP] rejected POST: missing/invalid session ID");
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[MCP] POST /mcp error:", err?.message ?? err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET (SSE stream) and DELETE (terminate) both require a valid, live session.
async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports.has(sessionId)) {
    console.warn(`[MCP] rejected ${req.method}: missing/unknown session ID`);
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Invalid or missing session ID" },
      id: null,
    });
  }

  try {
    await transports.get(sessionId).handleRequest(req, res);
  } catch (err) {
    console.error(`[MCP] ${req.method} /mcp error:`, err?.message ?? err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

mcpRouter.get("/mcp", handleSessionRequest);
mcpRouter.delete("/mcp", handleSessionRequest);
