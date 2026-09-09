const raw = String(import.meta.env.VITE_API_URL ?? "").trim().replace(/\/$/, "");

function isLocalhostUrl(value) {
  try {
    const url = new URL(value, "http://localhost");
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

// Empty = same origin (nginx proxies /api). Never call localhost from a hosted UI.
export const API_BASE = !raw || isLocalhostUrl(raw) ? "" : raw;
export const API_KEY = import.meta.env.VITE_API_KEY ?? "";
