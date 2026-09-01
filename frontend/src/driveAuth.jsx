import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useGoogleLogin } from "@react-oauth/google";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const API_KEY  = import.meta.env.VITE_API_KEY ?? "";

const jsonHeaders = {
  "Content-Type": "application/json",
  ...(API_KEY ? { "x-api-key": API_KEY } : {}),
};

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const TOKEN_KEY = "collider_drive_token";
const EXP_KEY   = "collider_drive_exp";

const RENEW_LEAD_MS  = 5 * 60 * 1000;
const RENEW_RETRY_MS = 5 * 60 * 1000;

const DriveAuthContext = createContext(null);

export function useDriveAuth() {
  const ctx = useContext(DriveAuthContext);
  if (!ctx) throw new Error("useDriveAuth must be used within DriveAuthProvider");
  return ctx;
}

function readStored() {
  try {
    let token = localStorage.getItem(TOKEN_KEY) || "";
    let exp   = Number(localStorage.getItem(EXP_KEY) || 0);
    if (!token) {
      token = sessionStorage.getItem(TOKEN_KEY) || "";
      exp   = Number(sessionStorage.getItem(EXP_KEY) || 0);
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(EXP_KEY, String(exp));
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(EXP_KEY);
      }
    }
    return { token, exp };
  } catch {
    return { token: "", exp: 0 };
  }
}

function writeStored(token, exp) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EXP_KEY, String(exp));
}

function clearStored() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXP_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXP_KEY);
}

export function DriveAuthProvider({ children }) {
  const stored = readStored();
  const [token, setToken]       = useState(stored.token);
  const [tokenExp, setTokenExp] = useState(stored.exp);
  const [authError, setAuthError] = useState("");
  const [renewing, setRenewing] = useState(false);

  const pushToken = useCallback(async (accessToken, expiresIn) => {
    const res = await fetch(`${API_BASE}/api/drive/connect`, {
      method:  "POST",
      headers: jsonHeaders,
      body:    JSON.stringify({ access_token: accessToken, expires_in: expiresIn }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to register the connection");
    return data;
  }, []);

  const acceptToken = useCallback((accessToken, expiresIn) => {
    const ttl = Math.max(60, Number(expiresIn) || 3600);
    const exp = Date.now() + ttl * 1000;
    writeStored(accessToken, exp);
    setToken(accessToken);
    setTokenExp(exp);
    setAuthError("");
    setRenewing(false);
    pushToken(accessToken, ttl).catch((err) => {
      console.error("[drive] could not register token for auto-ingest:", err.message);
    });
  }, [pushToken]);

  const connect = useGoogleLogin({
    flow:  "implicit",
    scope: DRIVE_SCOPE,
    onSuccess: (resp) => acceptToken(resp.access_token, resp.expires_in),
    onError: () => setAuthError("Google Drive authorization failed."),
  });

  const renewToken = useGoogleLogin({
    flow:   "implicit",
    scope:  DRIVE_SCOPE,
    prompt: "",
    onSuccess: (resp) => acceptToken(resp.access_token, resp.expires_in),
    onError: () => setRenewing(false),
  });

  const renewRef  = useRef(renewToken);
  const tokenRef  = useRef(token);
  const expRef    = useRef(tokenExp);
  renewRef.current = renewToken;
  tokenRef.current = token;
  expRef.current   = tokenExp;

  const renew = useCallback(() => {
    setRenewing(true);
    try {
      renewRef.current();
    } catch (err) {
      console.error("[drive] silent renew failed:", err.message);
      setRenewing(false);
    }
  }, []);

  useEffect(() => {
    const { token: t, exp } = readStored();
    if (t && exp > Date.now() + 30_000) {
      pushToken(t, Math.round((exp - Date.now()) / 1000)).catch(() => {});
      return;
    }
    // Revive a previously connected Drive session; do not prompt first-time users.
    if (t) renew();
  }, [pushToken, renew]);

  useEffect(() => {
    if (!tokenExp) return;
    const delay = Math.max(1000, tokenExp - Date.now() - RENEW_LEAD_MS);
    const timer = setTimeout(() => renew(), delay);
    return () => clearTimeout(timer);
  }, [tokenExp, renew]);

  useEffect(() => {
    const id = setInterval(() => {
      const t   = tokenRef.current;
      const exp = expRef.current;
      if (!exp) return;
      if (!t || Date.now() >= exp - RENEW_LEAD_MS) renew();
    }, RENEW_RETRY_MS);
    return () => clearInterval(id);
  }, [renew]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      const t   = tokenRef.current;
      const exp = expRef.current;
      if (!exp) return;
      if (!t || Date.now() >= exp - RENEW_LEAD_MS) renew();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [renew]);

  useEffect(() => {
    function onStorage(e) {
      if (e.key !== TOKEN_KEY && e.key !== EXP_KEY) return;
      const { token: t, exp } = readStored();
      setToken(t);
      setTokenExp(exp);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const disconnect = useCallback(async () => {
    clearStored();
    setToken("");
    setTokenExp(0);
    const res  = await fetch(`${API_BASE}/api/drive/disconnect`, {
      method: "POST", headers: jsonHeaders,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to disconnect");
    return data;
  }, []);

  const driveHeaders = useCallback((extra = {}) => ({
    ...extra,
    ...(token ? { "x-google-access-token": token } : {}),
  }), [token]);

  const live = Boolean(token) && tokenExp > Date.now() + 30_000;

  return (
    <DriveAuthContext.Provider value={{
      token, tokenExp, live, renewing, authError, setAuthError,
      connect, disconnect, renew, driveHeaders,
    }}>
      {children}
    </DriveAuthContext.Provider>
  );
}
