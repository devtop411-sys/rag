import "./config/env.js";
import app from "./app.js";
import { EMBEDDING_MODEL, EXPECTED_DENSE_SIZE, COLLECTION } from "./config/constants.js";

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`RAG service running on port ${PORT}`);
  console.log(`Embedding model : ${EMBEDDING_MODEL} (${EXPECTED_DENSE_SIZE} dims, Voyage AI)`);
  console.log(`Qdrant URL      : ${process.env.QDRANT_URL}`);
  console.log(`Collection      : ${COLLECTION}`);
});
