import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { verifyGoogleCredential } from "../services/auth.service.js";
import { SIGNING_KEY } from "../config/jwt.js";
import { ADMIN_EMAILS } from "../config/constants.js";
import { upsertUser } from "../services/users.service.js";

const APP_TOKEN_TTL = Number(process.env.APP_TOKEN_TTL || 86400); // 24h

async function issueAppToken({ email, name }) {
  return new SignJWT({ name, token_type: "app" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime(`${APP_TOKEN_TTL}s`)
    .setJti(randomUUID())
    .sign(SIGNING_KEY);
}

// POST /auth/google
export async function googleAuth(req, res) {
  try {
    const { credential } = req.body ?? {};
    if (!credential) return res.status(400).json({ error: "credential is required" });

    const { email, name, picture } = await verifyGoogleCredential(credential);

    const stored = await upsertUser({ email, name, picture });
    const role = ADMIN_EMAILS.has(email) ? "admin" : (stored.role || "user");

    const token = await issueAppToken({ email, name });

    res.json({ ok: true, email, name, picture, token, role });
  } catch (error) {
    console.error("[auth/google] error:", error);
    const status = error.status ?? 500;
    res.status(status).json({ error: error.message });
  }
}
