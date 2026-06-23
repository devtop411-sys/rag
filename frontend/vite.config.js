import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ingest":      "http://localhost:3001",
      "/retrieve":    "http://localhost:3001",
      "/search":      "http://localhost:3001",
      "/documents":   "http://localhost:3001",
      "/auth/google": "http://localhost:3001",
      "/api":         "http://localhost:3001",
    },
  },
});
