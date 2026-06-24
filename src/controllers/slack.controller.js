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

  if (!event || event.bot_id) return;
  if (event.type !== "app_mention" && event.type !== "message") return;

  const question = event.text.replace(/<@[^>]+>/g, "").trim();
  console.log("QUESTION:", question);

  const difyResponse = await fetch("http://34.245.224.130/v1/chat-messages", {
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

  const data = await difyResponse.json();
  console.log("DIFY RESPONSE:", data);

  await slack.chat.postMessage({
    channel:   event.channel,
    thread_ts: event.ts,
    text:      data.answer || "No answer from Dify",
  });
}
