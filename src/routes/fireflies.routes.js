import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { optionalAuth } from "../middleware/requireAuth.js";
import {
  status,
  connect,
  disconnect,
  test,
  meetings,
  ingest,
  getSettings,
  updateSettings,
  sync,
  syncStatus,
} from "../controllers/fireflies.controller.js";

const router = Router();

router.get("/api/fireflies/status",       requireApiKey, status);
router.post("/api/fireflies/connect",     requireApiKey, connect);
router.post("/api/fireflies/disconnect",  requireApiKey, disconnect);
router.post("/api/fireflies/test",        requireApiKey, test);
router.get("/api/fireflies/meetings",     requireApiKey, optionalAuth, meetings);
router.post("/api/fireflies/ingest",      requireApiKey, optionalAuth, ingest);
router.get("/api/fireflies/settings",     requireApiKey, getSettings);
router.put("/api/fireflies/settings",     requireApiKey, updateSettings);
router.post("/api/fireflies/sync",        requireApiKey, sync);
router.get("/api/fireflies/sync",         requireApiKey, syncStatus);

export default router;
