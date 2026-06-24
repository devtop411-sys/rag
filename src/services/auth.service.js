import { ALLOWED_DOMAIN, ALLOWED_EMAILS } from "../config/constants.js";

/**
 * Verifies a Google ID token via the Google tokeninfo endpoint.
 * Restricts access to @collider.vc accounts and the explicit allow-list.
 *
 * @param {string} credential  JWT returned by the Google Sign-In button
 * @returns {Promise<{ email: string, name: string, picture: string|null }>}
 * @throws {Error} with a `status` property set to the appropriate HTTP code
 */
export async function verifyGoogleCredential(credential) {
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
  if (!r.ok) {
    const err = new Error("Invalid Google token");
    err.status = 401;
    throw err;
  }

  const payload = await r.json();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (clientId && payload.aud !== clientId) {
    const err = new Error("Token audience mismatch");
    err.status = 401;
    throw err;
  }

  const email = (payload.email ?? "").toLowerCase();
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`) && !ALLOWED_EMAILS.has(email)) {
    const err = new Error(`Access restricted to @${ALLOWED_DOMAIN} accounts`);
    err.status = 403;
    throw err;
  }

  console.log(`[auth/google] Login: ${email}`);
  return {
    email,
    name:    payload.name    ?? email,
    picture: payload.picture ?? null,
  };
}
