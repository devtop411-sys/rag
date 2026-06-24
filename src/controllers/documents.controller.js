import { COLLECTION } from "../config/constants.js";
import { qdrant } from "../services/qdrant.service.js";

// GET /documents — list unique ingested documents
export async function listDocuments(req, res) {
  try {
    const results = await qdrant.scroll(COLLECTION, {
      with_payload: [
        "document_id", "source", "original_filename", "type",
        "file_size", "embedding_model", "created_at", "author", "document_date",
      ],
      with_vector: false,
      limit:       1000,
    });

    const seen = new Map();
    for (const point of results.points) {
      const p = point.payload;
      if (!seen.has(p.document_id)) {
        seen.set(p.document_id, {
          document_id:       p.document_id,
          source:            p.source,
          original_filename: p.original_filename,
          type:              p.type,
          file_size:         p.file_size,
          author:            p.author        ?? null,
          document_date:     p.document_date ?? null,
          embedding_model:   p.embedding_model ?? "unknown",
          created_at:        p.created_at,
        });
      }
    }

    res.json({ documents: Array.from(seen.values()) });
  } catch (error) {
    console.error("[documents] error:", error);
    res.status(500).json({ error: error.message });
  }
}

// DELETE /documents/:documentId
export async function deleteDocument(req, res) {
  try {
    const { documentId } = req.params;

    await qdrant.delete(COLLECTION, {
      wait:   true,
      filter: { must: [{ key: "document_id", match: { value: documentId } }] },
    });

    console.log(`[delete] Removed all chunks for document_id: ${documentId}`);
    res.json({ ok: true, document_id: documentId });
  } catch (error) {
    console.error("[delete] error:", error);
    res.status(500).json({ error: error.message });
  }
}
