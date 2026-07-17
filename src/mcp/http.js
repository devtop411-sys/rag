import express from "express";

import { mcpRouter } from "./streamableHttp.js";
import { oauthRouter } from "./oauth.js";
import { COLLECTION, EMBEDDING_MODEL, EXPECTED_DENSE_SIZE } from "../config/constants.js";

// ---------------------------------------------------------------------------
// Optional standalone launcher for the Streamable HTTP MCP endpoint.
//
// In production the MCP endpoint is served by the MAIN backend (src/app.js) on
// the existing PORT — no extra port is bound. This launcher only exists for
// local development / isolated testing and reuses the exact same stateful
// `mcpRouter`, so behaviour is identical to production.
// ---------------------------------------------------------------------------
export async function startMcpHttpServer() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok", ok: true }));
  app.use(oauthRouter);
  app.use(mcpRouter);

  const PORT = process.env.MCP_PORT || 3002;
  app.listen(PORT, () => {
    console.error(`[MCP HTTP] rag-knowledge-base listening on :${PORT}/mcp (standalone)`);
    console.error(`[MCP HTTP] auth: OAuth 2.1 bearer required (Google sign-in)`);
    console.error(`[MCP HTTP] Qdrant collection: ${COLLECTION}`);
    console.error(`[MCP HTTP] Embedding model: ${EMBEDDING_MODEL} (${EXPECTED_DENSE_SIZE} dims)`);
  });
}
