import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const mcpProxyTarget = env.VITE_MCP_PROXY_TARGET || "https://rag.collider.vc";
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://localhost:3001";

  const mcpProxy = {
    target: mcpProxyTarget,
    changeOrigin: true,
    secure: true,
  };

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/mcp": mcpProxy,
        "/oauth": mcpProxy,
        "/.well-known": mcpProxy,
        "/ingest": apiProxyTarget,
        "/retrieve": apiProxyTarget,
        "/search": apiProxyTarget,
        "/documents": apiProxyTarget,
        "/auth": apiProxyTarget,
        "/api": apiProxyTarget,
        "/health": apiProxyTarget,
        "/slack": apiProxyTarget,
      },
    },
  };
});
