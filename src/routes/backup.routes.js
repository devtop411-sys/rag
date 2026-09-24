import { Router } from "express";
import { backupCollection } from "../services/backup.service.js";
import { COLLECTION }       from "../config/constants.js";

const router = Router();

/**
 * POST /backup
 * Trigger an on-demand Qdrant → S3 backup.
 * Body (optional): { "collection": "custom_name" }
 */
router.post("/backup", async (req, res) => {
  const collection = req.body?.collection || COLLECTION;
  try {
    const result = await backupCollection(collection);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[POST /backup]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
