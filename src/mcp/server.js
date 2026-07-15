import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import { embedTexts } from "../services/embeddings.service.js";
import { qdrant, ensureCollection } from "../services/qdrant.service.js";
import {
  generateSearchQueryMetadata,
  generateChunkMetadata,
} from "../services/document.service.js";
import {
  buildSearchEmbeddingText,
  buildEmbeddingText,
} from "../utils/text.utils.js";
import {
  COLLECTION,
  EMBEDDING_MODEL,
  EXPECTED_DENSE_SIZE,
} from "../config/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function chunkText(text, chunkSize, chunkOverlap) {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  return splitter.splitText(text);
}

function formatResults(results) {
  if (!results.length) return "No results found.";
  return results
    .map(
      (r, i) =>
        `[${i + 1}] score: ${r.score.toFixed(4)}\nsource: ${r.payload.source ?? "unknown"}\nchunk: ${r.payload.chunk_index ?? 0}\n\n${r.payload.text}`,
    )
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// MCP server factory
//
// Returns a fully-configured McpServer with all tools registered. A fresh
// instance is created per stdio process and per HTTP request (stateless mode).
// ---------------------------------------------------------------------------
export function createMcpServer() {
  const server = new McpServer({
    name: "rag-knowledge-base",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

function registerTools(server) {
// ---------------------------------------------------------------------------
// Tool: hello  (connectivity check for Claude Custom Connectors)
// ---------------------------------------------------------------------------
server.tool(
  "hello",
  "Returns a test message confirming that the Collider MCP server is working.",
  {
    name: z.string().optional().describe("Optional name to greet"),
  },
  async ({ name }) => {
    const who = name && name.trim() ? name.trim() : "Claude";
    return {
      content: [
        { type: "text", text: `Hello, ${who}! Collider MCP server is working.` },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: search_knowledge_base
//
// Thin wrapper over the existing RAG/Qdrant search pipeline (same embedding
// model + collection used by the REST /search route). Returns plain text with
// source attribution (fileName + document_id) when available.
// ---------------------------------------------------------------------------
server.tool(
  "search_knowledge_base",
  "Search the Collider knowledge base for information relevant to a user query.",
  {
    query: z.string().min(1).describe("The user query to search the knowledge base for"),
  },
  async ({ query }) => {
    try {
      const queryMeta = await generateSearchQueryMetadata(query);
      const searchText = queryMeta
        ? buildSearchEmbeddingText(query, queryMeta)
        : query;

      const [embedding] = await embedTexts([searchText]);

      const hits = await qdrant.search(COLLECTION, {
        vector: embedding,
        limit: 5,
        with_payload: ["text", "source", "chunk_index", "document_id"],
      });

      if (!hits.length) {
        return {
          content: [
            { type: "text", text: "No relevant information found in the knowledge base." },
          ],
        };
      }

      const text = hits
        .map((h, i) => {
          const p = h.payload ?? {};
          const lines = [`[${i + 1}] score: ${h.score.toFixed(4)}`];
          if (p.source) lines.push(`fileName: ${p.source}`);
          if (p.document_id) lines.push(`document_id: ${p.document_id}`);
          lines.push("", p.text ?? "");
          return lines.join("\n");
        })
        .join("\n\n---\n\n");

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error searching knowledge base: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: search
// ---------------------------------------------------------------------------
server.tool(
  "search",
  "Semantically search the RAG knowledge base and return the most relevant document chunks.",
  {
    query: z.string().min(1).describe("The search question or query"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of chunks to return (default 5)"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Optional financial topic tags to filter results"),
  },
  async ({ query, limit, tags }) => {
    try {
      const queryMeta = await generateSearchQueryMetadata(query);
      const searchText = queryMeta
        ? buildSearchEmbeddingText(query, queryMeta)
        : query;

      const [embedding] = await embedTexts([searchText]);

      let results = [];

      if (Array.isArray(tags) && tags.length > 0) {
        const filtered = await qdrant.search(COLLECTION, {
          vector: embedding,
          limit,
          with_payload: true,
          filter: { must: [{ key: "meta_query", match: { any: tags } }] },
        });
        results = filtered;
      }

      if (results.length < 2) {
        const fallback = await qdrant.search(COLLECTION, {
          vector: embedding,
          limit,
          with_payload: true,
        });
        const seen = new Set(results.map((r) => r.id));
        for (const hit of fallback) {
          if (!seen.has(hit.id)) results.push(hit);
        }
      }

      const text = formatResults(results.slice(0, limit));
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: ingest_text
// ---------------------------------------------------------------------------
server.tool(
  "ingest_text",
  "Ingest a text passage into the knowledge base. The text is chunked, enriched with metadata, and stored as embeddings in Qdrant.",
  {
    text: z.string().min(10).describe("The text content to ingest"),
    source: z
      .string()
      .min(1)
      .describe("A name or identifier for this content (e.g. document title)"),
    chunk_size: z
      .number()
      .int()
      .min(100)
      .max(4000)
      .default(800)
      .describe("Chunk size in characters (default 800)"),
    chunk_overlap: z
      .number()
      .int()
      .min(0)
      .max(500)
      .default(150)
      .describe("Overlap between chunks in characters (default 150)"),
  },
  async ({ text, source, chunk_size, chunk_overlap }) => {
    try {
      const chunks = await chunkText(text, chunk_size, chunk_overlap);
      if (!chunks.length) {
        return {
          content: [{ type: "text", text: "Error: no chunks generated from the provided text." }],
          isError: true,
        };
      }

      const llmEnabled = !!process.env.OPENAI_API_KEY;

      // Generate chunk metadata for enriched embeddings.
      let chunkMetadatas = chunks.map(() => null);
      if (llmEnabled) {
        chunkMetadatas = await Promise.all(
          chunks.map((c) => generateChunkMetadata(c)),
        );
      }

      const embeddingTexts = chunks.map((c, i) => {
        const meta = chunkMetadatas[i];
        if (!meta) return c;
        return buildEmbeddingText({
          text: c,
          summary: meta.summary,
          keywords: meta.keywords,
          search_queries: meta.search_queries,
        });
      });

      const embeddings = await embedTexts(embeddingTexts);
      await ensureCollection(embeddings[0].length);

      const documentId = uuidv4();
      const points = chunks.map((c, i) => {
        const meta = chunkMetadatas[i];
        return {
          id: uuidv4(),
          vector: embeddings[i],
          payload: {
            document_id: documentId,
            source,
            chunk_index: i,
            text: c,
            summary: meta?.summary ?? null,
            keywords: meta?.keywords ?? [],
            search_queries: meta?.search_queries ?? [],
            meta_query: [],
            embedding_model: EMBEDDING_MODEL,
            created_at: new Date().toISOString(),
          },
        };
      });

      await qdrant.upsert(COLLECTION, { wait: true, points });

      return {
        content: [
          {
            type: "text",
            text: `Ingested "${source}" — ${chunks.length} chunk(s), document_id: ${documentId}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: list_documents
// ---------------------------------------------------------------------------
server.tool(
  "list_documents",
  "List all documents currently stored in the knowledge base, grouped by document ID.",
  {},
  async () => {
    try {
      const seen = new Map();
      let offset = null;

      // Scroll all points to collect unique documents.
      do {
        const page = await qdrant.scroll(COLLECTION, {
          limit: 250,
          offset: offset ?? undefined,
          with_payload: ["document_id", "source", "chunk_index", "created_at"],
          with_vector: false,
        });

        for (const point of page.points) {
          const { document_id, source, chunk_index, created_at } =
            point.payload ?? {};
          if (!document_id) continue;
          if (!seen.has(document_id)) {
            seen.set(document_id, { document_id, source, chunks: 0, created_at });
          }
          seen.get(document_id).chunks += 1;
        }

        offset = page.next_page_offset ?? null;
      } while (offset !== null);

      if (!seen.size) {
        return { content: [{ type: "text", text: "No documents found." }] };
      }

      const lines = [...seen.values()]
        .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
        .map(
          (d, i) =>
            `${i + 1}. ${d.source ?? "(unknown)"}\n   id: ${d.document_id}  chunks: ${d.chunks}  ingested: ${d.created_at?.slice(0, 10) ?? "?"}`,
        );

      return {
        content: [
          {
            type: "text",
            text: `${seen.size} document(s) in the knowledge base:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: delete_document
// ---------------------------------------------------------------------------
server.tool(
  "delete_document",
  "Delete all chunks of a document from the knowledge base by its document ID.",
  {
    document_id: z
      .string()
      .uuid()
      .describe("The document_id to delete (UUID returned by ingest or list_documents)"),
  },
  async ({ document_id }) => {
    try {
      await qdrant.delete(COLLECTION, {
        wait: true,
        filter: {
          must: [{ key: "document_id", match: { value: document_id } }],
        },
      });

      return {
        content: [
          {
            type: "text",
            text: `Deleted all chunks for document_id: ${document_id}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);
}

// ---------------------------------------------------------------------------
// Start (stdio transport — for local clients that spawn the process)
// ---------------------------------------------------------------------------
export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] rag-knowledge-base server running on stdio");
  console.error(`[MCP] Qdrant: ${process.env.QDRANT_URL}  collection: ${COLLECTION}`);
  console.error(`[MCP] Embedding model: ${EMBEDDING_MODEL} (${EXPECTED_DENSE_SIZE} dims)`);
}
