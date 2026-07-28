import { v4 as uuidv4 } from "uuid";

import { COLLECTION, EMBEDDING_MODEL, S3_BUCKET } from "../config/constants.js";
import { embedTexts } from "./embeddings.service.js";
import { qdrant, ensureCollection } from "./qdrant.service.js";
import { getTranscript, transcriptToChunks, normalizeMeeting } from "./fireflies.service.js";
import { s3, PutObjectCommand } from "./s3.service.js";

function describeError(err) {
  const code = err?.cause?.code || err?.code;
  return code ? `${err.message} (${code})` : err.message;
}

function buildMeetingEmbeddingText({ title, summary, participants, text }) {
  const parts = [`Meeting: ${title}`];
  if (participants?.length) parts.push(`Participants: ${participants.join(", ")}`);
  if (summary) parts.push(`Summary: ${summary}`);
  parts.push(`Transcript:\n${text}`);
  return parts.join("\n\n");
}

async function deleteExistingMeetingChunks(meetingId) {
  try {
    await qdrant.delete(COLLECTION, {
      wait: true,
      filter: { must: [{ key: "meeting_id", match: { value: meetingId } }] },
    });
  } catch (err) {
    // Missing collection → nothing to delete.
    const is404 =
      err.message === "Not Found" || err.$metadata?.httpStatusCode === 404;
    if (!is404) console.error("[fireflies] delete existing chunks failed:", err.message);
  }
}

async function storeRawTranscript(meetingId, transcript) {
  if (!S3_BUCKET) return;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket:      S3_BUCKET,
        Key:         `fireflies/${meetingId}.json`,
        Body:        JSON.stringify(transcript),
        ContentType: "application/json",
      })
    );
  } catch (err) {
    console.error(`[fireflies] Failed to store raw transcript ${meetingId}:`, err.message);
  }
}

export async function ingestMeeting(apiKey, meetingId) {
  const transcript = await getTranscript(apiKey, meetingId);
  const meta = normalizeMeeting(transcript);

  const chunks = transcriptToChunks(transcript.sentences);
  if (!chunks.length) {
    throw new Error("Transcript has no sentences to ingest");
  }

  const summaryText =
    transcript.summary?.overview || transcript.summary?.short_summary || "";
  const keywords = Array.isArray(transcript.summary?.keywords)
    ? transcript.summary.keywords
    : [];

  const embeddingTexts = chunks.map((c) =>
    buildMeetingEmbeddingText({
      title:        meta.title,
      summary:      summaryText,
      participants: meta.participants,
      text:         c.text,
    })
  );

  console.log(
    `[fireflies] Ingesting "${meta.title}" (${meetingId}) → ${chunks.length} chunks`
  );
  let embeddings;
  try {
    embeddings = await embedTexts(embeddingTexts);
  } catch (err) {
    throw new Error(`Voyage embedding request failed: ${describeError(err)}`);
  }

  try {
    await ensureCollection(embeddings[0].length);
    await deleteExistingMeetingChunks(meetingId);
  } catch (err) {
    throw new Error(`Qdrant not reachable (${process.env.QDRANT_URL}): ${describeError(err)}`);
  }

  await storeRawTranscript(meetingId, transcript);

  const documentId = uuidv4();
  const createdAt = new Date().toISOString();

  const docTags = [];
  if (meta.organizer) docTags.push(`organizer:${meta.organizer}`);
  if (meta.date_string) docTags.push(`date:${meta.date_string.slice(0, 10)}`);

  const points = chunks.map((c, i) => ({
    id:     uuidv4(),
    vector: embeddings[i],
    payload: {
      document_id:     documentId,
      source:          "fireflies",
      meeting_id:      meetingId,
      meeting_title:   meta.title,
      meeting_date:    meta.date_string,
      participants:    meta.participants,
      organizer:       meta.organizer,
      meeting_url:     meta.meeting_url,
      speaker:         c.speakers.join(", "),
      start_time:      c.start_time,
      end_time:        c.end_time,
      chunk_index:     c.chunk_index,
      text:            c.text,
      summary:         summaryText || null,
      keywords,
      meta_query:      [...keywords.map((k) => String(k).toLowerCase()), ...docTags],
      embedding_model: EMBEDDING_MODEL,
      created_at:      createdAt,
    },
  }));

  try {
    await qdrant.upsert(COLLECTION, { wait: true, points });
  } catch (err) {
    throw new Error(`Qdrant upsert failed (${process.env.QDRANT_URL}): ${describeError(err)}`);
  }
  console.log(`[fireflies] Upserted ${points.length} chunks for "${meta.title}"`);

  return { meeting_id: meetingId, document_id: documentId, chunks: points.length };
}

export async function getMeetingIngestState(meetingId) {
  try {
    const res = await qdrant.count(COLLECTION, {
      filter: { must: [{ key: "meeting_id", match: { value: meetingId } }] },
      exact: true,
    });
    const count = res?.count ?? 0;
    return { ingested: count > 0, chunks: count };
  } catch {
    return { ingested: false, chunks: 0 };
  }
}
