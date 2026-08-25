import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import {
  status,
  connect,
  disconnect,
  files,
  listAll,
  ingest,
  getSettings,
  updateSettings,
  sync,
  syncStatus,
} from "../controllers/drive.controller.js";

const router = Router();

router.get("/api/drive/status",      requireApiKey, status);
router.post("/api/drive/connect",    requireApiKey, connect);
router.post("/api/drive/disconnect", requireApiKey, disconnect);

router.get("/api/drive/files",       requireApiKey, files);
router.get("/api/drive/files/all",   requireApiKey, listAll);
router.post("/api/drive/ingest",     requireApiKey, ingest);

router.get("/api/drive/settings",    requireApiKey, getSettings);
router.put("/api/drive/settings",    requireApiKey, updateSettings);

router.get("/api/drive/sync",        requireApiKey, syncStatus);
router.post("/api/drive/sync",       requireApiKey, sync);

export default router;
