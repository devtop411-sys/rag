import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { uploadMemory } from "../middleware/upload.js";
import { uploadToS3, listS3Files, deleteS3File } from "../controllers/s3.controller.js";

const router = Router();

router.post("/api/s3/upload",  requireApiKey, uploadMemory.array("files", 20), uploadToS3);
router.get("/api/s3/files",    requireApiKey, listS3Files);
router.delete("/api/s3/file",  requireApiKey, deleteS3File);

export default router;
