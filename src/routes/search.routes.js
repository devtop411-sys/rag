import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { optionalAuth } from "../middleware/requireAuth.js";
import { search, retrieve } from "../controllers/search.controller.js";

const router = Router();

router.post("/search",   requireApiKey, optionalAuth, search);
router.post("/retrieve", requireApiKey, retrieve);

export default router;
