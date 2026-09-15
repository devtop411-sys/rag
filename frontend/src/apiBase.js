const raw = String(import.meta.env.VITE_API_URL ?? "").trim().replace(/\/$/, "");

function resolveApiBase() {
  if (!raw) return "";
  try {
    const url = new URL(raw, "http://localhost");
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return "";
    if (typeof window !== "undefined" && url.origin !== window.location.origin) return "";
  } catch {
    return "";
  }
  return raw;
}

export const API_BASE = resolveApiBase();
export const API_KEY = import.meta.env.VITE_API_KEY ?? "";
