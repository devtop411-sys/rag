// Redirect console.log → stderr so stdout stays clean for MCP JSON-RPC.
console.log = (...args) => console.error(...args);

import "./src/config/env.js";
import { startMcpServer } from "./src/mcp/server.js";

startMcpServer().catch((err) => {
  console.error("[MCP] Fatal error:", err);
  process.exit(1);
});
