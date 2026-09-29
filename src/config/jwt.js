import { randomBytes } from "node:crypto";

let signingSecret = process.env.OAUTH_SIGNING_SECRET;
const EPHEMERAL = !signingSecret;
if (EPHEMERAL) {
  signingSecret = randomBytes(48).toString("base64url");
  console.warn(
    "[jwt] OAUTH_SIGNING_SECRET is not set — using an ephemeral signing key. " +
      "Tokens will be invalidated on restart.",
  );
}
export const SIGNING_KEY = new TextEncoder().encode(signingSecret);
export const IS_EPHEMERAL_KEY = EPHEMERAL;
