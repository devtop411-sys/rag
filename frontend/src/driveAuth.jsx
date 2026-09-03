import { createContext, useCallback, useContext, useState } from "react";
import { useGoogleLogin } from "@react-oauth/google";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const API_KEY  = import.meta.env.VITE_API_KEY ?? "";

const jsonHeaders = {
  "Content-Type": "application/json",
  ...(API_KEY ? { "x-api-key": API_KEY } : {}),
};

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const DriveAuthContext = createContext(null);

export function useDriveAuth() {
  const ctx = useContext(DriveAuthContext);
  if (!ctx) throw new Error("useDriveAuth must be used within DriveAuthProvider");
  return ctx;
}

export function DriveAuthProvider({ children }) {
  const [authError, setAuthError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState(null);

  const exchangeCode = useCallback(async (code) => {
    const res = await fetch(`${API_BASE}/api/drive/connect`, {
      method:  "POST",
      headers: jsonHeaders,
      body:    JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to connect Google Drive");
    setConnection(data);
    setAuthError("");
    return data;
  }, []);

  const login = useGoogleLogin({
    flow:         "auth-code",
    ux_mode:      "popup",
    scope:        DRIVE_SCOPE,
    access_type:  "offline",
    prompt:       "consent",
    onSuccess: async (resp) => {
      setConnecting(true);
      try {
        await exchangeCode(resp.code);
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
