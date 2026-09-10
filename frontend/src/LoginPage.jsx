import { useState } from "react";
import { GoogleLogin } from "@react-oauth/google";

const LOGIN_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

export default function LoginPage({ onLogin }) {
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSuccess(credentialResponse) {
    setLoading(true);
    setError("");
    try {
      const res  = await fetch("/auth/google", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ credential: credentialResponse.credential }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Authentication failed");
      onLogin(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">⚡</div>
          <h1 className="login-title">Collider VC</h1>
          <p className="login-subtitle">Sign in with your @collider.vc account. The popup lets you pick which Google account to use.</p>

          <div className="login-btn-wrap">
            {loading ? (
                <div className="login-loading">
                  <span className="spinner" />
                  Verifying…
                </div>
            ) : (
                <GoogleLogin
                    onSuccess={handleSuccess}
                    onError={() => setError("Google sign-in failed. Please try again.")}
                    theme="filled_black"
                    size="large"
                    width="280"
                    text="signin_with"
                    shape="rectangular"
                    useOneTap={false}
                    auto_select={false}
                    use_fedcm_for_prompt={false}
                    ux_mode="popup"
                    prompt="select_account"
                />
            )}
          </div>

          {error && (
              <div className="login-error">
                {error}
              </div>
          )}

          <p className="login-subtitle" style={{ marginTop: 16, wordBreak: "break-all" }}>
            Origin: {typeof window !== "undefined" ? window.location.origin : ""}
            <br />
            Client ID: {LOGIN_CLIENT_ID || "(missing VITE_GOOGLE_CLIENT_ID)"}
          </p>
        </div>
      </div>
  );
}
