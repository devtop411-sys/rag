import fs from "fs/promises";

export async function safeUnlink(filePath) {
  if (!filePath) return;
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}
