import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { upload } from "../middleware/upload.js";
import { ingestFile, ingestFromS3 } from "../controllers/ingest.controller.js";

const router = Router();

router.post("/ingest",         requireApiKey, upload.single("file"), ingestFile);
router.post("/api/ingest/s3",  requireApiKey, ingestFromS3);

export default router;
