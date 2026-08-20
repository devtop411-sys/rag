import pdfParse from "pdf-parse";
import { v4 as uuidv4 } from "uuid";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import { COLLECTION, EMBEDDING_MODEL } from "../config/constants.js";
import { embedTexts } from "./embeddings.service.js";
import { qdrant, ensureCollection, getIngestState } from "./qdrant.service.js";
import {
  generateMetaQuery,
  generateChunkMetadata,
  extractDocumentMeta,
  extractText,
} from "./document.service.js";
import { buildEmbeddingText } from "../utils/text.utils.js";
import { runWithConcurrency } from "../utils/concurrency.utils.js";
import {
  FOLDER_MIME,
  isIngestible,
  downloadDriveFile,
  getDriveFileMeta,
} from "./googleDrive.service.js";

async function chunkText(rawText, chunkSize, chunkOverlap) {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  const looksLikeMarkdown = /^#{1,3} /m.test(rawText);

  if (looksLikeMarkdown) {
    const sections = rawText
      .split(/\n(?=#{1,3} )/)
      .map((s) => s.trim())
      .filter(Boolean);

    const parts = await Promise.all(
      sections.map((s) => (s.length > chunkSize ? splitter.splitText(s) : [s]))
    );
    return parts.flat().filter(Boolean);
  }

  return splitter.splitText(rawText);
}

async function deleteExistingChunks(driveFileId) {
  try {
    await qdrant.delete(COLLECTION, {
      wait: true,
      filter: { must: [{ key: "driveFileId", match: { value: driveFileId } }] },
    });
  } catch (err) {
    const is404 = err.message === "Not Found" || err.$metadata?.httpStatusCode === 404;
    if (!is404) console.error("[drive] delete existing chunks failed:", err.message);
  }
}

export function getDriveIngestState(driveFileId) {
  return getIngestState("driveFileId", driveFileId);
}

export async function ingestDriveFile(accessToken, fileId) {
  const meta = await getDriveFileMeta(accessToken, fileId);
  if (meta.mimeType === FOLDER_MIME) {
    throw new Error("Folders cannot be ingested — open the folder and pick files");
  }
  if (!isIngestible(meta.mimeType)) {
    throw new Error(`Unsupported file type "${meta.mimeType}"`);
  }

  const wasIngested = (await getDriveIngestState(meta.id)).ingested;

  console.log(`[drive] Downloading "${meta.name}" (${meta.id})…`);
  const { buffer, ext, fileName } = await downloadDriveFile(accessToken, meta);

  let rawText;
  let pdfAuthor = null;
  if (ext === ".pdf") {
    const parsed = await pdfParse(buffer);
    rawText = parsed.text;
    pdfAuthor = parsed.info?.Author?.trim() || null;
  } else {
    rawText = await extractText(buffer, ext);
  }
  if (!rawText?.trim()) throw new Error("No text extracted from file");

  const chunks = await chunkText(rawText, 800, 150);
  if (!chunks.length) throw new Error("No chunks generated");
  console.log(`[drive] "${fileName}" → ${chunks.length} chunks`);

  const metaQueryEnabled = !!process.env.OPENAI_API_KEY;

  let chunkMetadatas = chunks.map(() => null);
  if (metaQueryEnabled) {
    chunkMetadatas = await runWithConcurrency(
      chunks.map((text) => () => generateChunkMetadata(text)),
      5
    );
  }

  const embeddingTexts = chunks.map((text, i) => {
    const chunkMeta = chunkMetadatas[i];
    if (!chunkMeta) return text;
    return buildEmbeddingText({
      text,
      summary:        chunkMeta.summary,
      keywords:       chunkMeta.keywords,
      search_queries: chunkMeta.search_queries,
    });
  });

  const embeddings = await embedTexts(embeddingTexts);

  let metaQueries = chunks.map(() => []);
  if (metaQueryEnabled) {
    metaQueries = await runWithConcurrency(
      chunks.map((text) => () => generateMetaQuery(text)),
      5
    );
  }

  const driveDate = meta.modifiedTime
    ? new Date(meta.modifiedTime).toISOString().slice(0, 10)
    : null;

  let author = pdfAuthor;
  let documentDate = driveDate;
  if (!author && metaQueryEnabled) {
    const llmMeta = await extractDocumentMeta(rawText);
    author = llmMeta.author;
  }

  const docTags = [];
  if (author)       docTags.push(`author:${author}`);
  if (documentDate) docTags.push(`date:${documentDate}`);

  await ensureCollection(embeddings[0].length);

  const documentId = uuidv4();
  const createdAt = new Date().toISOString();
  const points = chunks.map((text, i) => {
    const chunkMeta = chunkMetadatas[i];
    return {
      id:     uuidv4(),
      vector: embeddings[i],
      payload: {
        document_id:       documentId,
        source:            "google_drive",
        driveFileId:       meta.id,
        fileName,
        original_filename: fileName,
        mime_type:         meta.mimeType,
        webViewLink:       meta.webViewLink ?? null,
        chunk_index:       i,
        text,
        summary:           chunkMeta?.summary       ?? null,
        keywords:          chunkMeta?.keywords       ?? [],
        search_queries:    chunkMeta?.search_queries ?? [],
        meta_query:        [...(metaQueries[i] ?? []), ...docTags],
        embedding_model:   EMBEDDING_MODEL,
        created_at:        createdAt,
      },
    };
  });

  await deleteExistingChunks(meta.id);
  await qdrant.upsert(COLLECTION, { wait: true, points });
  console.log(
    `[drive] ${wasIngested ? "Updated" : "Upserted"} ${points.length} vectors for "${fileName}"`
  );

  return { id: meta.id, chunks: points.length, updated: wasIngested, fileName };
}

export async function ingestDriveFiles(accessToken, ids) {
  const results = [];
  for (const id of ids) {
    try {
      const r = await ingestDriveFile(accessToken, id);
      results.push({ id, status: "ingested", chunks: r.chunks, updated: r.updated });
    } catch (err) {
      console.error(`[drive] ingest ${id} failed:`, err.message);
      results.push({ id, status: "failed", error: err.message });
    }
  }
  return results;
}
