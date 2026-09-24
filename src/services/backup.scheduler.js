/**
 * Simple interval-based backup scheduler.
 *
 * Runs inside the existing backend process — no extra container needed.
 * Default: every 24 h (override with BACKUP_INTERVAL_HOURS).
 * Set BACKUP_ENABLED=true to activate.
 */

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
  // Run immediately on startup, then repeat on interval
  tick();
  timer = setInterval(tick, INTERVAL);
  // Don't keep the process alive just for backups
  timer.unref();
}

export function stopBackupScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
