import { backupCollection } from "./backup.service.js";

const ENABLED  = (process.env.BACKUP_ENABLED || "").toLowerCase() === "true";
const INTERVAL = Number(process.env.BACKUP_INTERVAL_HOURS || 24) * 60 * 60 * 1000;

let timer = null;

async function tick() {
  try {
    const result = await backupCollection();
    console.log(`[backup-scheduler] ✓ ${result.s3Key}`);
  } catch (err) {
    console.error("[backup-scheduler] Backup failed:", err.message || err);
  }
}

export function startBackupScheduler() {
  if (!ENABLED) {
    console.log("[backup-scheduler] Disabled (set BACKUP_ENABLED=true to enable)");
    return;
  }
  console.log(
    `[backup-scheduler] Running first backup now, then every ${INTERVAL / 3_600_000}h`,
  );
  tick();
  timer = setInterval(tick, INTERVAL);
  timer.unref();
}

export function stopBackupScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
