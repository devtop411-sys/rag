import { jwtVerify } from "jose";
import { SIGNING_KEY } from "../config/jwt.js";
import { ADMIN_EMAILS } from "../config/constants.js";
import { getUserRole } from "../services/users.service.js";

async function resolveRole(email) {
  if (ADMIN_EMAILS.has(email)) return "admin";
  try {
    return await getUserRole(email);
  } catch {
    return "user";
  }
}

export async function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  try {
    const { payload } = await jwtVerify(match[1].trim(), SIGNING_KEY);
    if (payload.token_type !== "app") {
      return res.status(401).json({ error: "Invalid token type" });
    }
    const role = await resolveRole(payload.sub);
    req.user = {
      email: payload.sub,
      name:  payload.name || payload.sub,
      role,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export async function optionalAuth(req, _res, next) {
  const header = req.headers["authorization"] || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return next();

  try {
    const { payload } = await jwtVerify(match[1].trim(), SIGNING_KEY);
    if (payload.token_type === "app") {
      const role = await resolveRole(payload.sub);
      req.user = {
        email: payload.sub,
        name:  payload.name || payload.sub,
        role,
      };
    }
  } catch {}
  next();
}
