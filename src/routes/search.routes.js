import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { search, retrieve } from "../controllers/search.controller.js";

const router = Router();

router.post("/search",   requireApiKey, search);
router.post("/retrieve", requireApiKey, retrieve);

export default router;
