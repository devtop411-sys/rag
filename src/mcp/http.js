import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpServer } from "./server.js";
import { COLLECTION, EMBEDDING_MODEL, EXPECTED_DENSE_SIZE } from "../config/constants.js";

// ---------------------------------------------------------------------------
// Streamable HTTP MCP server (stateless mode).
//
// Each POST /mcp request gets a fresh McpServer + transport pair, so no
// per-session state is kept in memory — ideal behind a load balancer or proxy.
// ---------------------------------------------------------------------------
export async function startMcpHttpServer() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, transport: "streamable-http" }));

  app.post("/mcp", async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[MCP HTTP] request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode does not support server-initiated GET/DELETE sessions.
  const methodNotAllowed = (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode" },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const PORT = process.env.MCP_PORT || 3002;
  app.listen(PORT, () => {
    console.error(`[MCP HTTP] rag-knowledge-base listening on :${PORT}/mcp`);
    console.error(`[MCP HTTP] auth: OPEN (no authentication)`);
    console.error(`[MCP HTTP] Qdrant: ${process.env.QDRANT_URL}  collection: ${COLLECTION}`);
    console.error(`[MCP HTTP] Embedding model: ${EMBEDDING_MODEL} (${EXPECTED_DENSE_SIZE} dims)`);
  });
}
