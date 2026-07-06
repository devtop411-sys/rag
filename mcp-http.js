// Redirect console.log → stderr so stdout stays clean (consistency with stdio mode).
console.log = (...args) => console.error(...args);

import "./src/config/env.js";
import { startMcpHttpServer } from "./src/mcp/http.js";

startMcpHttpServer().catch((err) => {
  console.error("[MCP HTTP] Fatal error:", err);
  process.exit(1);
});
