import { Router } from "express";
import { slackEvents } from "../controllers/slack.controller.js";

const router = Router();

router.post("/slack/events", slackEvents);

export default router;
