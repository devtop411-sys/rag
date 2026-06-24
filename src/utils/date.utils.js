/**
 * Normalises PDF date strings like "D:20231015120000+03'00'" → "2023-10-15".
 * Falls back to ISO parsing for human-readable date strings.
 */
export function parsePdfDate(raw) {
  if (!raw) return null;
  const m = /^D:(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
