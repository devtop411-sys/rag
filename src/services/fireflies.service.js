import { FIREFLIES_GQL_URL } from "../config/constants.js";

export async function firefliesRequest(apiKey, query, variables = {}) {
  if (!apiKey) throw new Error("Fireflies API key is not configured");

  const response = await fetch(FIREFLIES_GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Fireflies returned non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    const msg = body?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`Fireflies API error: ${msg}`);
  }
  if (body.errors?.length) {
    throw new Error(`Fireflies API error: ${body.errors[0].message}`);
  }

  return body.data;
}

export async function testConnection(apiKey) {
  const data = await firefliesRequest(
    apiKey,
    `query { user { email name } }`
  );
  const user = data?.user;
  return {
    email: user?.email || null,
    name:  user?.name || null,
  };
}

export async function listTranscripts(apiKey, { limit = 50, skip = 0 } = {}) {
  const data = await firefliesRequest(
    apiKey,
    `query Transcripts($limit: Int, $skip: Int) {
      transcripts(limit: $limit, skip: $skip) {
        id
        title
        date
        dateString
        duration
        organizer_email
        host_email
        participants
        transcript_url
      }
    }`,
    { limit, skip }
  );

  return (data?.transcripts || []).map(normalizeMeeting);
}

export async function getTranscript(apiKey, id) {
  const data = await firefliesRequest(
    apiKey,
    `query Transcript($transcriptId: String!) {
      transcript(id: $transcriptId) {
        id
        title
        date
        dateString
        duration
        organizer_email
        host_email
        participants
        transcript_url
        summary {
          overview
          short_summary
          keywords
          action_items
          topics_discussed
        }
        sentences {
          speaker_name
          text
          start_time
          end_time
        }
      }
    }`,
    { transcriptId: id }
  );

  const t = data?.transcript;
  if (!t) throw new Error(`Transcript ${id} not found`);
  return t;
}

export function normalizeMeeting(t) {
  return {
    id:           t.id,
    title:        t.title || "Untitled meeting",
    date:         typeof t.date === "number" ? t.date : null,
    date_string:  t.dateString || (t.date ? new Date(t.date).toISOString() : null),
    duration:     t.duration || 0, // seconds
    organizer:    t.organizer_email || t.host_email || null,
    participants: Array.isArray(t.participants) ? t.participants : [],
    meeting_url:  t.transcript_url || null,
  };
}

export function transcriptToChunks(
  sentences,
  { targetChars = 1200, overlapChars = 150 } = {}
) {
  const clean = (sentences || []).filter((s) => s && (s.text || "").trim());
  if (!clean.length) return [];

  const lineFor = (s) =>
    `${s.speaker_name || "Speaker"} [${formatTimestamp(s.start_time)}]: ${s.text.trim()}`;

  const groups = [];
  let cur = [];
  let curLen = 0;

  for (const s of clean) {
    const len = lineFor(s).length;
    if (curLen + len > targetChars && cur.length) {
      groups.push(cur);

      const overlap = [];
      let oLen = 0;
      for (let i = cur.length - 1; i >= 0; i--) {
        const l = lineFor(cur[i]).length;
        if (oLen + l > overlapChars) break;
        overlap.unshift(cur[i]);
        oLen += l;
      }
      cur = [...overlap];
      curLen = oLen;
    }
    cur.push(s);
    curLen += len;
  }
  if (cur.length) groups.push(cur);

  return groups.map((group, index) => {
    const speakers = [...new Set(group.map((s) => s.speaker_name).filter(Boolean))];
    return {
      chunk_index: index,
      text:        group.map(lineFor).join("\n"),
      start_time:  group[0].start_time ?? null,
      end_time:    group[group.length - 1].end_time ?? null,
      speakers,
    };
  });
}

export function formatTimestamp(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "00:00";
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
