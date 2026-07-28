import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
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
} from "../controllers/fireflies.controller.js";

const router = Router();

router.get("/api/fireflies/status",       requireApiKey, status);
router.post("/api/fireflies/connect",     requireApiKey, connect);
router.post("/api/fireflies/disconnect",  requireApiKey, disconnect);
router.post("/api/fireflies/test",        requireApiKey, test);
router.get("/api/fireflies/meetings",     requireApiKey, meetings);
router.post("/api/fireflies/ingest",      requireApiKey, ingest);
router.get("/api/fireflies/settings",     requireApiKey, getSettings);
router.put("/api/fireflies/settings",     requireApiKey, updateSettings);
router.post("/api/fireflies/sync",        requireApiKey, sync);

export default router;
