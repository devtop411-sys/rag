export function requireApiKey(req, res, next) {
  const configuredKey = process.env.API_KEY;
  if (!configuredKey) return next();
  const provided = req.headers["x-api-key"];
  if (!provided || provided !== configuredKey) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing x-api-key" });
  }
  next();
}
