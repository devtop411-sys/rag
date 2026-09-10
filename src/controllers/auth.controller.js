import crypto from "node:crypto";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../config/constants.js";
import { verifyGoogleCredential } from "../services/auth.service.js";

const STATE_COOKIE = "g_oauth_state";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function publicOrigin(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
      .split(",")[0]
      .trim();
    return `${proto}://${host}`;
  }
  const env = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (env) return env;
  return `https://${host}`;
}

function redirectUri(req) {
  return `${publicOrigin(req)}/auth/google/callback`;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function htmlPage(title, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { max-width: 480px; padding: 24px; background: #1e293b; border-radius: 12px; }
  a { color: #93c5fd; }
</style></head><body><div class="card">${body}</div></body></html>`;
}

function loginSuccessPage(user) {
  const json = JSON.stringify({
    email: user.email,
    name: user.name,
    picture: user.picture,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><script>
localStorage.setItem("collider_user", ${JSON.stringify(json)});
location.replace("/");
</script></body></html>`;
}

export async function googleAuth(req, res) {
  try {
    const { credential } = req.body ?? {};
    if (!credential) return res.status(400).json({ error: "credential is required" });

    const { email, name, picture } = await verifyGoogleCredential(credential);
    res.json({ ok: true, email, name, picture });
  } catch (error) {
    console.error("[auth/google] error:", error);
    const status = error.status ?? 500;
    res.status(status).json({ error: error.message });
  }
}

export function googleStart(req, res) {
  if (!GOOGLE_CLIENT_ID) {
    return res
      .status(500)
      .send(htmlPage("Login error", "<p>GOOGLE_CLIENT_ID is not configured on the server.</p>"));
  }

  const state = crypto.randomBytes(16).toString("hex");
  const uri = redirectUri(req);
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  uri,
    response_type: "code",
    scope:         "openid email profile",
    prompt:        "select_account",
    state,
    access_type:   "online",
  });

  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure:   !uri.startsWith("http://localhost"),
    maxAge:   10 * 60 * 1000,
    path:     "/auth",
  });

  res.redirect(302, `${GOOGLE_AUTH_URL}?${params}`);
}

export async function googleCallback(req, res) {
  try {
    const code  = String(req.query.code || "");
    const state = String(req.query.state || "");
    const error = String(req.query.error || "");
    if (error) {
      return res.status(400).send(htmlPage("Login cancelled", `<p>${error}</p><p><a href="/">Try again</a></p>`));
    }

    const expected = readCookie(req, STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) {
      return res
        .status(400)
        .send(htmlPage("Login error", `<p>Invalid login state. Close this tab and try Sign in again.</p><p><a href="/">Back</a></p>`));
    }

    if (!GOOGLE_CLIENT_SECRET) {
      return res.status(500).send(htmlPage(
        "Login error",
        "<p>GOOGLE_CLIENT_SECRET is not set. Add the Web client secret, then redeploy.</p>",
      ));
    }

    const uri = redirectUri(req);
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  uri,
        grant_type:    "authorization_code",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      const msg = tokens.error_description || tokens.error || `HTTP ${tokenRes.status}`;
      console.error("[auth/google/callback] token error:", msg);
      return res.status(400).send(htmlPage(
        "Login error",
        `<p>Google token error: ${msg}</p>
         <p>Add this exact redirect URI on the same Web client as GOOGLE_CLIENT_ID:</p>
         <p><code>${uri}</code></p>
         <p><a href="/">Try again</a></p>`,
      ));
    }

    if (!tokens.id_token) {
      return res.status(400).send(htmlPage("Login error", "<p>Google did not return an ID token.</p>"));
    }

    const user = await verifyGoogleCredential(tokens.id_token);
    res.clearCookie(STATE_COOKIE, { path: "/auth" });
    res.status(200).type("html").send(loginSuccessPage(user));
  } catch (error) {
    console.error("[auth/google/callback] error:", error);
    res.status(error.status ?? 500).send(htmlPage(
      "Login error",
      `<p>${error.message || "Login failed"}</p><p><a href="/">Try again</a></p>`,
    ));
  }
}
