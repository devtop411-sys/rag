import { Router } from "express";
import { googleAuth, googleCallback, googleStart } from "../controllers/auth.controller.js";

const router = Router();

router.post("/google", googleAuth);
router.get("/google/start", googleStart);
router.get("/google/callback", googleCallback);

export default router;
