import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, repoRoot, ""),
    ...loadEnv(mode, process.cwd(), ""),
  };
  const googleClientId =
    env.VITE_GOOGLE_CLIENT_ID ||
    env.GOOGLE_CLIENT_ID ||
    env.MCP_GOOGLE_CLIENT_ID ||
    "";
  const driveClientId = googleClientId;
  const mcpProxyTarget = env.VITE_MCP_PROXY_TARGET || "https://rag.collider.vc";
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://localhost:3001";

  const mcpProxy = {
    target: mcpProxyTarget,
    changeOrigin: true,
    secure: true,
  };

  return {
    plugins: [react()],
    envDir: repoRoot,
    define: {
      "import.meta.env.VITE_GOOGLE_CLIENT_ID": JSON.stringify(googleClientId),
      "import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID": JSON.stringify(driveClientId),
      "import.meta.env.VITE_API_KEY": JSON.stringify(env.VITE_API_KEY || env.API_KEY || ""),
    },
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
