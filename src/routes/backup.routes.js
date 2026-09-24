import { Router } from "express";
import { backupCollection } from "../services/backup.service.js";
import { COLLECTION }       from "../config/constants.js";

const router = Router();

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
