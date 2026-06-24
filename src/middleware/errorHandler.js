// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  console.error("[errorHandler]", err);
  const status = err.status ?? err.statusCode ?? 500;
  res.status(status).json({ error: err.message ?? "Internal server error" });
}
