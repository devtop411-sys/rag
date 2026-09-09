import { createContext, useCallback, useContext, useState } from "react";
import { useGoogleLogin } from "@react-oauth/google";
import { API_BASE, API_KEY } from "./apiBase.js";

const jsonHeaders = {
  "Content-Type": "application/json",
  ...(API_KEY ? { "x-api-key": API_KEY } : {}),
};

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const DriveAuthContext = createContext(null);

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
  const appEmail = storedUserEmail();
  const [authError, setAuthError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState(null);

  const exchangeCode = useCallback(async (code) => {
    if (!code) {
      throw new Error("Google did not return an authorization code. Try Connect again.");
    }
    let res;
    try {
      res = await fetch(`${API_BASE}/api/drive/connect`, {
        method:  "POST",
        headers: jsonHeaders,
        body:    JSON.stringify({ code, redirect_uri: "postmessage" }),
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

  const login = useGoogleLogin({
    flow:            "auth-code",
    ux_mode:         "popup",
    redirect_uri:    "postmessage",
    scope:           DRIVE_SCOPE,
    access_type:     "offline",
    prompt:          "consent",
    hint:            appEmail,
    login_hint:      appEmail,
    select_account:  false,
    onSuccess: async (resp) => {
      setConnecting(true);
      try {
        await exchangeCode(resp?.code);
      } catch (err) {
        setAuthError(err.message || "Google Drive authorization failed.");
      } finally {
        setConnecting(false);
      }
    },
    onError: () => {
      setConnecting(false);
      setAuthError("Google Drive authorization failed.");
    },
    onNonOAuthError: () => {
      setConnecting(false);
      setAuthError("Google Drive authorization was cancelled.");
    },
  });

  const connect = useCallback(() => {
    setAuthError("");
    setConnecting(true);
    try {
      login();
    } catch (err) {
      setConnecting(false);
      setAuthError(err.message || "Google Drive authorization failed.");
    }
  }, [login]);

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
      appEmail,
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
