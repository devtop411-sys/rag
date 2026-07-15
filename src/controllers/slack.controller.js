import { slack } from "../services/slack.service.js";
import {
  s3,
  S3_BUCKET,
  S3_PREFIX,
  PRESIGN_TTL,
  GetObjectCommand,
  ListObjectsV2Command,
  getSignedUrl,
} from "../services/s3.service.js";

function extractSources(data) {
  const resources = data?.metadata?.retriever_resources ?? [];
  const names = resources
    .map((r) => r.document_name || r.dataset_name)
    .filter(Boolean);
  return [...new Set(names)];
}

function normalizeName(name) {
  return name
    .replace(/^[0-9a-f-]+-/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .toLowerCase();
}

async function resolveSourceLinks(names) {
  if (!names.length) return [];

  let objects = [];
  if (S3_BUCKET) {
    try {
      const data = await s3.send(
        new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: S3_PREFIX })
      );
      objects = (data.Contents ?? [])
        .filter((obj) => obj.Key !== S3_PREFIX)
        .map((obj) => ({
          key:      obj.Key,
          fileName: obj.Key.replace(S3_PREFIX, "").replace(/^[0-9a-f-]+-/, ""),
        }));
    } catch (err) {
      console.error("[slack] Failed to list S3 objects for sources:", err);
    }
  }

  return Promise.all(
    names.map(async (name) => {
      const target = normalizeName(name);
      const match = objects.find((o) => normalizeName(o.fileName) === target);

      if (!match) return `• ${name}`;

      try {
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: S3_BUCKET, Key: match.key }),
          { expiresIn: PRESIGN_TTL }
        );
        return `• <${url}|${name}>`;
      } catch (err) {
        console.error(`[slack] Failed to presign "${match.key}":`, err);
        return `• ${name}`;
      }
    })
  );
}

// POST /slack/events
export async function slackEvents(req, res) {
  console.log("SLACK REQUEST:", JSON.stringify(req.body, null, 2));

  const body = req.body;

  if (body.type === "url_verification") {
    return res.send(body.challenge);
  }

  res.sendStatus(200);

  const event = body.event;
  console.log("EVENT:", event);

  if (!event || event.bot_id || event.subtype) return;
  if (event.type !== "app_mention" && event.type !== "message") return;

  const question = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
  if (!question) return;
  console.log("QUESTION:", question);

  try {
    const difyUrl = process.env.DIFY_URL || "http://34.245.224.130/v1/chat-messages";
    const difyResponse = await fetch(difyUrl, {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${process.env.DIFY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs:        {},
        query:         question,
        response_mode: "blocking",
        user:          event.user,
      }),
    });

    if (!difyResponse.ok) {
      const errText = await difyResponse.text();
      console.error("DIFY ERROR:", difyResponse.status, errText);
      await slack.chat.postMessage({
        channel:   event.channel,
        thread_ts: event.ts,
        text:      `Sorry, I couldn't reach the knowledge base (Dify ${difyResponse.status}).`,
      });
      return;
    }

    const data = await difyResponse.json();
    console.log("DIFY RESPONSE:", data);

    const answer = data.answer || "No answer from Dify";
    const sourceLinks = await resolveSourceLinks(extractSources(data));
    const text = sourceLinks.length
      ? `${answer}\n\n*Sources:*\n${sourceLinks.join("\n")}`
      : answer;

    await slack.chat.postMessage({
      channel:   event.channel,
      thread_ts: event.ts,
      text,
    });
  } catch (err) {
    console.error("SLACK HANDLER ERROR:", err);
    try {
      await slack.chat.postMessage({
        channel:   event.channel,
        thread_ts: event.ts,
        text:      "Sorry, something went wrong while answering your question.",
      });
    } catch (postErr) {
      console.error("SLACK POST ERROR:", postErr);
    }
  }
}
