import { verifyGoogleCredential } from "../services/auth.service.js";

// POST /auth/google
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
