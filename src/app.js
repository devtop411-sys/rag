import express from "express";
import cors from "cors";

import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";

import healthRoutes    from "./routes/health.routes.js";
import authRoutes      from "./routes/auth.routes.js";
import ingestRoutes    from "./routes/ingest.routes.js";
import searchRoutes    from "./routes/search.routes.js";
import documentsRoutes from "./routes/documents.routes.js";
import s3Routes        from "./routes/s3.routes.js";
import slackRoutes     from "./routes/slack.routes.js";
import firefliesRoutes from "./routes/fireflies.routes.js";
import driveRoutes     from "./routes/drive.routes.js";
import { mcpRouter }   from "./mcp/streamableHttp.js";
import { oauthRouter } from "./mcp/oauth.js";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "x-api-key",
      "x-google-access-token",
      "mcp-session-id",
      "Mcp-Session-Id",
    ],
    exposedHeaders: ["mcp-session-id", "Mcp-Session-Id", "WWW-Authenticate"],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);
app.use(express.json({ limit: "10mb" }));

app.use(healthRoutes);
app.use(oauthRouter);
app.use(mcpRouter);
app.use("/auth", authRoutes);
app.use(ingestRoutes);
app.use(searchRoutes);
app.use(documentsRoutes);
app.use(s3Routes);
app.use(slackRoutes);
app.use(firefliesRoutes);
app.use(driveRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
