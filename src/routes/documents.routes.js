import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { listDocuments, deleteDocument } from "../controllers/documents.controller.js";

const router = Router();

router.get("/documents",                requireApiKey, listDocuments);
router.delete("/documents/:documentId", requireApiKey, deleteDocument);

export default router;
