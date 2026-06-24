/**
 * Runs an array of async thunks with at most `limit` in flight at once.
 * Returns results in the same order as the input tasks array.
 */
export async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  const executing = new Set();
  let idx = 0;

  async function runNext() {
    if (idx >= tasks.length) return;
    const i = idx++;
    const p = tasks[i]().then((r) => { results[i] = r; executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runNext));
  return results;
}
