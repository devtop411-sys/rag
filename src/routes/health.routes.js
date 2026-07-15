import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => res.json({ status: "ok", ok: true }));

export default router;
