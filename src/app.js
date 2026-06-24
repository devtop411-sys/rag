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

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use(healthRoutes);
app.use("/auth", authRoutes);
app.use(ingestRoutes);
app.use(searchRoutes);
app.use(documentsRoutes);
app.use(s3Routes);
app.use(slackRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
