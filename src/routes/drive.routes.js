import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { status, files, ingest } from "../controllers/drive.controller.js";

const router = Router();

router.get("/api/drive/status",  requireApiKey, status);
router.get("/api/drive/files",   requireApiKey, files);
router.post("/api/drive/ingest", requireApiKey, ingest);

export default router;
