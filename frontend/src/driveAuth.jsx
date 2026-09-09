import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { API_BASE, API_KEY } from "./apiBase.js";

const jsonHeaders = {
  "Content-Type": "application/json",
  ...(API_KEY ? { "x-api-key": API_KEY } : {}),
};

const authHeaders = API_KEY ? { "x-api-key": API_KEY } : {};

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const CALLBACK_PATH = "/drive";
const STATE_KEY = "drive_oauth_state";

const DriveAuthContext = createContext(null);

let callbackInflight = null;

function driveRedirectUri() {
  return `${window.location.origin}${CALLBACK_PATH}`;
}

function pendingDriveCallback() {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  return url.pathname === CALLBACK_PATH && (url.searchParams.has("code") || url.searchParams.has("error"));
}

function storedUserEmail() {
  try {
    const user = JSON.parse(localStorage.getItem("collider_user") ?? "null");
    return String(user?.email || "").trim();
  } catch {
    return "";
  }
}

export function useDriveAuth() {
  const ctx = useContext(DriveAuthContext);
  if (!ctx) throw new Error("useDriveAuth must be used within DriveAuthProvider");
  return ctx;
}

export function DriveAuthProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [authError, setAuthError] = useState("");
  const [connecting, setConnecting] = useState(() => pendingDriveCallback());
  const [connection, setConnection] = useState(null);

  const exchangeCode = useCallback(async (code, redirectUri) => {
    let res;
    try {
      res = await fetch(`${API_BASE}/api/drive/connect`, {
        method:  "POST",
        headers: jsonHeaders,
        body:    JSON.stringify({ code, redirect_uri: redirectUri }),
      });
    } catch {
      throw new Error("Could not reach the API from this page. Redeploy so the UI calls /api on the same domain.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to connect Google Drive");
    setConnection(data);
    setAuthError("");
    return data;
  }, []);

  const clearCallbackParams = useCallback(() => {
    navigate(CALLBACK_PATH, { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (location.pathname !== CALLBACK_PATH) return;

    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const oauthError = params.get("error");
    const state = params.get("state");
    if (!code && !oauthError) return;

    const key = location.search;

    const attach = (promise) => {
      setConnecting(true);
      promise
        .catch((err) => {
          setAuthError(err.message || "Google Drive authorization failed.");
        })
        .finally(() => {
          setConnecting(false);
          clearCallbackParams();
        });
    };

    if (callbackInflight?.key === key) {
      attach(callbackInflight.promise);
      return;
    }

    if (oauthError) {
      sessionStorage.removeItem(STATE_KEY);
      const failed = Promise.reject(
        new Error(
          oauthError === "access_denied"
            ? "Google Drive authorization was cancelled."
            : `Google Drive authorization failed: ${oauthError}`,
        ),
      );
      callbackInflight = { key, promise: failed };
      attach(failed);
      return;
    }

    const expected = sessionStorage.getItem(STATE_KEY);
    if (!expected || expected !== state) {
      sessionStorage.removeItem(STATE_KEY);
      const failed = Promise.reject(
        new Error("Google Drive authorization state mismatch. Please try connecting again."),
      );
      callbackInflight = { key, promise: failed };
      attach(failed);
      return;
    }

    sessionStorage.removeItem(STATE_KEY);
    const promise = exchangeCode(code, driveRedirectUri());
    callbackInflight = { key, promise };
    attach(promise);
  }, [location.pathname, location.search, exchangeCode, clearCallbackParams]);

  const connect = useCallback(async () => {
    setAuthError("");
    setConnecting(true);
    try {
      const state = crypto.randomUUID();
      sessionStorage.setItem(STATE_KEY, state);
      const redirectUri = driveRedirectUri();
      const qs = new URLSearchParams({ redirect_uri: redirectUri, state });
      const loginHint = storedUserEmail();
      if (loginHint) qs.set("login_hint", loginHint);
      const res = await fetch(`${API_BASE}/api/drive/authorize?${qs}`, {
        headers: authHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to start Google Drive login");
      if (!data.url) throw new Error("Authorize endpoint did not return a URL");
      window.location.assign(data.url);
    } catch (err) {
      sessionStorage.removeItem(STATE_KEY);
      setConnecting(false);
      setAuthError(err.message || "Google Drive authorization failed.");
    }
  }, []);

  const disconnect = useCallback(async () => {
    const res  = await fetch(`${API_BASE}/api/drive/disconnect`, {
      method: "POST", headers: jsonHeaders,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to disconnect");
    setConnection(data);
    return data;
  }, []);

  return (
    <DriveAuthContext.Provider value={{
      authError,
      setAuthError,
      connecting,
      connection,
      setConnection,
      connect,
      disconnect,
      live: Boolean(connection?.connected),
      renewing: connecting,
      renew: connect,
      driveHeaders: (extra = {}) => ({ ...extra }),
    }}>
      {children}
    </DriveAuthContext.Provider>
  );
}
