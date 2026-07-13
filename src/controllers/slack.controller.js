import { slack } from "../services/slack.service.js";

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

    await slack.chat.postMessage({
      channel:   event.channel,
      thread_ts: event.ts,
      text:      data.answer || "No answer from Dify",
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
