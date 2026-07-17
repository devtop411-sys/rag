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
import { mcpRouter }   from "./mcp/streamableHttp.js";
import { oauthRouter } from "./mcp/oauth.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use(healthRoutes);
// OAuth 2.1 authorization server for the MCP endpoint (metadata discovery,
// dynamic client registration, Google-backed login, token issuing). Must be
// mounted before the notFound handler and before mcpRouter's auth guard runs.
app.use(oauthRouter);
// MCP Streamable HTTP endpoint (POST/GET/DELETE /mcp). Mounted before the
// notFound handler so it is never swallowed by the SPA/404 fallback.
app.use(mcpRouter);
app.use("/auth", authRoutes);
app.use(ingestRoutes);
app.use(searchRoutes);
app.use(documentsRoutes);
app.use(s3Routes);
app.use(slackRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
