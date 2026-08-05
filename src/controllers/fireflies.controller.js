import { getConnection, saveConnection, getApiKey } from "../services/fireflies.state.js";
import { testConnection, listTranscripts } from "../services/fireflies.service.js";
import { ingestMeeting, getMeetingIngestState } from "../services/fireflies.ingest.js";
import { runSync } from "../services/fireflies.sync.js";


const MEETINGS_CACHE_TTL = 60 * 1000; // 60s
const meetingsCache = new Map(); // key: `${skip}:${limit}` -> { at, data }

function publicConnection(conn) {
  return {
    connected:      conn.status === "connected" && !!conn.api_key,
    status:         conn.status,
    account:        conn.account,
    last_synced_at: conn.last_synced_at,
    auto_sync:      conn.auto_sync,
  };
}


export async function status(req, res) {
  try {
    const conn = await getConnection();
    res.json(publicConnection(conn));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function connect(req, res) {
  try {
    const apiKey = (req.body?.apiKey || "").trim();
    if (!apiKey) return res.status(400).json({ error: "apiKey is required" });

    let account;
    try {
      account = await testConnection(apiKey);
    } catch (err) {
      return res.status(400).json({ error: `Could not connect to Fireflies: ${err.message}` });
    }

    const conn = await saveConnection({
      api_key: apiKey,
      status:  "connected",
      account,
    });

    res.json(publicConnection(conn));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function disconnect(req, res) {
  try {
    const conn = await saveConnection({
      api_key: "",
      status:  "disconnected",
      account: null,
    });
    res.json(publicConnection(conn));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function test(req, res) {
  try {
    const apiKey = (req.body?.apiKey || "").trim() || (await getApiKey());
    if (!apiKey) return res.status(400).json({ error: "Not connected" });
    const account = await testConnection(apiKey);
    res.json({ ok: true, account });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}

export async function meetings(req, res) {
  try {
    const apiKey = await getApiKey();
    if (!apiKey) return res.status(400).json({ error: "Not connected to Fireflies" });

    const search = (req.query.search || "").toString().trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;
    const force = req.query.refresh === "1";

    const cacheKey = `${skip}:${limit}`;
    let list;
    let warning = null;
    const cached = meetingsCache.get(cacheKey);
    const cacheFresh = cached && Date.now() - cached.at < MEETINGS_CACHE_TTL;

    if (!force && cacheFresh) {
      list = cached.data;
    } else {
      try {
        list = await listTranscripts(apiKey, { limit, skip });
        meetingsCache.set(cacheKey, { at: Date.now(), data: list });
      } catch (err) {
        if (cached) {
          list = cached.data;
          warning = `Showing cached meetings — ${err.message}`;
        } else {
          throw err;
        }
      }
    }

    // A full page implies there may be another one. Search filters the current
    // page only (the Fireflies API has no server-side title search).
    const hasMore = list.length === limit;

    let filtered = list;
    if (search) {
      filtered = list.filter((m) => m.title.toLowerCase().includes(search));
    }

    const withState = await Promise.all(
      filtered.map(async (m) => {
        const state = await getMeetingIngestState(m.id);
        return { ...m, ...state };
      })
    );

    res.json({ meetings: withState, page, limit, hasMore, warning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function ingest(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: "ids array is required" });

    const apiKey = await getApiKey();
    if (!apiKey) return res.status(400).json({ error: "Not connected to Fireflies" });

    const results = [];
    for (const id of ids) {
      try {
        const r = await ingestMeeting(apiKey, id);
        results.push({ id, status: "ingested", chunks: r.chunks });
      } catch (err) {
        console.error(`[fireflies] ingest ${id} failed:`, err.message);
        results.push({ id, status: "failed", error: err.message });
      }
    }

    const allOk = results.every((r) => r.status === "ingested");
    const anyOk = results.some((r) => r.status === "ingested");
    res.json({ status: allOk ? "ok" : anyOk ? "partial_success" : "failed", results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getSettings(req, res) {
  try {
    const conn = await getConnection();
    res.json({ auto_sync: conn.auto_sync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateSettings(req, res) {
  try {
    const incoming = req.body?.auto_sync || req.body || {};
    const patch = {};
    if (typeof incoming.enabled === "boolean") patch.enabled = incoming.enabled;
    if (Number.isFinite(+incoming.frequency_minutes)) patch.frequency_minutes = +incoming.frequency_minutes;
    if (typeof incoming.only_external === "boolean") patch.only_external = incoming.only_external;
    if (Number.isFinite(+incoming.min_duration_minutes)) patch.min_duration_minutes = +incoming.min_duration_minutes;

    const conn = await saveConnection({ auto_sync: patch });
    res.json({ auto_sync: conn.auto_sync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function sync(req, res) {
  try {
    const result = await runSync({ force: true });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
