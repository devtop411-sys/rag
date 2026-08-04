import { useState, useEffect } from "react";

const API_BASE    = import.meta.env.VITE_API_URL ?? "";
const API_KEY     = import.meta.env.VITE_API_KEY ?? "";
const authHeaders = API_KEY ? { "x-api-key": API_KEY } : {};
const jsonHeaders = { "Content-Type": "application/json", ...authHeaders };

function formatDuration(seconds) {
  const mins = Math.round((seconds || 0) / 60);
  return `${mins} min`;
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

const DEFAULT_SETTINGS = {
  enabled:              false,
  frequency_minutes:    360,
  only_external:        true,
  min_duration_minutes: 5,
};

export default function FirefliesPage() {
  const [conn, setConn]           = useState(null);
  const [apiKeyInput, setApiKey]  = useState("");
  const [settings, setSettings]   = useState(DEFAULT_SETTINGS);

  const [meetings, setMeetings]   = useState([]);
  const [selected, setSelected]   = useState(new Set());
  const [search, setSearch]       = useState("");

  const [busy, setBusy]           = useState("");
  const [error, setError]         = useState("");
  const [notice, setNotice]       = useState("");

  useEffect(() => { loadStatus(); }, []);
  useEffect(() => {
    if (conn?.connected) { setSettings({ ...DEFAULT_SETTINGS, ...conn.auto_sync }); loadMeetings(); }
  }, [conn?.connected]);

  async function loadStatus() {
    try {
      const res  = await fetch(`${API_BASE}/api/fireflies/status`, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load status");
      setConn(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleConnect() {
    if (!apiKeyInput.trim()) return;
    setBusy("connect");
    setError("");
    try {
      const res  = await fetch(`${API_BASE}/api/fireflies/connect`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Connection failed");
      setApiKey("");
      setConn(data);
      setNotice("Connected to Fireflies.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect Fireflies? Ingested meetings stay in the knowledge base.")) return;
    setBusy("connect");
    try {
      const res  = await fetch(`${API_BASE}/api/fireflies/disconnect`, { method: "POST", headers: jsonHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to disconnect");
      setConn(data);
      setMeetings([]);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function loadMeetings(force = false) {
    setBusy("meetings");
    setError("");
    try {
      const url  = `${API_BASE}/api/fireflies/meetings?search=${encodeURIComponent(search)}${force ? "&refresh=1" : ""}`;
      const res  = await fetch(url, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load meetings");
      setMeetings(data.meetings ?? []);
      setSelected(new Set());
      setNotice(data.warning ?? "");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function ingestIds(ids) {
    if (!ids.length) return;
    setError("");
    setMeetings((prev) => prev.map((m) => ids.includes(m.id) ? { ...m, _status: "ingesting" } : m));
    try {
      const res  = await fetch(`${API_BASE}/api/fireflies/ingest`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Ingest failed");
      const map = Object.fromEntries((data.results ?? []).map((r) => [r.id, r]));
      setMeetings((prev) => prev.map((m) => {
        const r = map[m.id];
        if (!r) return { ...m, _status: undefined };
        if (r.status === "ingested") return { ...m, _status: undefined, ingested: true, chunks: r.chunks };
        return { ...m, _status: undefined, _error: r.error };
      }));
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
      setMeetings((prev) => prev.map((m) => ids.includes(m.id) ? { ...m, _status: undefined } : m));
    }
  }

  async function handleSyncNow() {
    setBusy("sync");
    setError("");
    setNotice("");
    try {
      const res  = await fetch(`${API_BASE}/api/fireflies/sync`, { method: "POST", headers: jsonHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed");
      setNotice(data.initialized
        ? "Sync baseline set — new meetings from now on will auto-ingest."
        : `Sync complete — ingested ${data.ingested ?? 0} meeting(s).`);
      await loadStatus();
      await loadMeetings();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function saveSettings() {
    setBusy("settings");
    setError("");
    try {
      const res  = await fetch(`${API_BASE}/api/fireflies/settings`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ auto_sync: settings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save settings");
      setSettings({ ...DEFAULT_SETTINGS, ...data.auto_sync });
      setNotice("Auto-sync settings saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }

  function toggleAll() {
    if (selected.size === meetings.length) setSelected(new Set());
    else setSelected(new Set(meetings.map((m) => m.id)));
  }

  const connected = conn?.connected;

  return (
    <main className="main">
        {error && (
          <div className="result result--error" style={{ maxWidth: 700 }}>
            <span className="result__icon">❌</span>
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="result result--success" style={{ maxWidth: 700 }}>
            <span className="result__icon">✅</span>
            <span>{notice}</span>
          </div>
        )}

        {/* Connection card */}
        <div className="fm-card" style={{ padding: 20, marginBottom: 20 }}>
          {!connected ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 520 }}>
              <div>
                <strong>Fireflies connector</strong>
                <p className="fm-meta" style={{ margin: "4px 0 0" }}>
                  Paste your Fireflies API key to connect. Find it in Fireflies →
                  Settings → Developer Settings.
                </p>
              </div>
              <input
                type="password"
                className="fm-input"
                placeholder="Fireflies API key"
                value={apiKeyInput}
                onChange={(e) => setApiKey(e.target.value)}
                style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #ccc" }}
              />
              <div>
                <button
                  className="btn btn--primary"
                  onClick={handleConnect}
                  disabled={busy === "connect" || !apiKeyInput.trim()}
                >
                  {busy === "connect" ? "Connecting…" : "Connect"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <strong>Fireflies</strong>
                  <span className="badge badge--success">Connected</span>
                </div>
                <span className="fm-meta">
                  Account: {conn.account?.email ?? conn.account?.name ?? "connected"}
                </span>
                <span className="fm-meta">
                  Last sync: {conn.last_synced_at ? new Date(conn.last_synced_at).toLocaleString() : "never"}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn--primary" onClick={handleSyncNow} disabled={busy === "sync"}>
                  {busy === "sync" ? "Syncing…" : "Sync now"}
                </button>
                <button className="btn btn--ghost btn--sm" onClick={handleDisconnect} disabled={busy === "connect"}>
                  Disconnect
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Auto-sync settings */}
        {connected && (
          <div className="fm-card" style={{ padding: 20, marginBottom: 20 }}>
            <strong>Automatic ingestion</strong>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12, maxWidth: 520 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  className="fm-checkbox"
                  checked={settings.enabled}
                  onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
                />
                Automatically ingest new meetings
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                Sync every
                <input
                  type="number"
                  min="5"
                  className="fm-input"
                  value={settings.frequency_minutes}
                  onChange={(e) => setSettings((s) => ({ ...s, frequency_minutes: +e.target.value }))}
                  style={{ width: 80, padding: "4px 8px", borderRadius: 6, border: "1px solid #ccc" }}
                />
                minutes
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  className="fm-checkbox"
                  checked={settings.only_external}
                  onChange={(e) => setSettings((s) => ({ ...s, only_external: e.target.checked }))}
                />
                Only meetings with external participants
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                Only meetings longer than
                <input
                  type="number"
                  min="0"
                  className="fm-input"
                  value={settings.min_duration_minutes}
                  onChange={(e) => setSettings((s) => ({ ...s, min_duration_minutes: +e.target.value }))}
                  style={{ width: 80, padding: "4px 8px", borderRadius: 6, border: "1px solid #ccc" }}
                />
                minutes
              </label>
              <div>
                <button className="btn btn--primary btn--sm" onClick={saveSettings} disabled={busy === "settings"}>
                  {busy === "settings" ? "Saving…" : "Save settings"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Meetings list */}
        {connected && (
          <>
            <div className="fm-toolbar">
              <input
                type="text"
                className="fm-input"
                placeholder="Search meetings…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadMeetings(true)}
                style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #ccc", minWidth: 220 }}
              />
              <button className="btn btn--ghost btn--sm" onClick={() => loadMeetings(true)} disabled={busy === "meetings"}>
                {busy === "meetings" ? "Loading…" : "Search"}
              </button>
              <button
                className="btn btn--primary"
                disabled={selected.size === 0}
                onClick={() => ingestIds([...selected])}
              >
                Ingest selected {selected.size > 0 && `(${selected.size})`}
              </button>
            </div>

            <div className="fm-card">
              {meetings.length === 0 && busy !== "meetings" && (
                <p className="fm-empty">No meetings found.</p>
              )}

              {meetings.length > 0 && (
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          className="fm-checkbox"
                          checked={selected.size === meetings.length && meetings.length > 0}
                          onChange={toggleAll}
                        />
                      </th>
                      <th>Meeting</th>
                      <th>Date</th>
                      <th>Duration</th>
                      <th>Participants</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {meetings.map((m) => {
                      const ingesting = m._status === "ingesting";
                      return (
                        <tr key={m.id} className={selected.has(m.id) ? "fm-row--selected" : ""}>
                          <td>
                            <input
                              type="checkbox"
                              className="fm-checkbox"
                              checked={selected.has(m.id)}
                              onChange={() => toggleSelect(m.id)}
                              disabled={ingesting}
                            />
                          </td>
                          <td className="fm-filename" title={m.title}>{m.title}</td>
                          <td className="fm-meta">{formatDate(m.date_string ?? m.date)}</td>
                          <td className="fm-meta">{formatDuration(m.duration)}</td>
                          <td className="fm-meta" title={(m.participants ?? []).join(", ")}>
                            {(m.participants ?? []).length}
                          </td>
                          <td>
                            {ingesting ? (
                              <span className="badge badge--loading">Ingesting…</span>
                            ) : m.ingested ? (
                              <span className="badge badge--success">Ingested · {m.chunks} chunks</span>
                            ) : (
                              <span className="badge badge--idle">Not ingested</span>
                            )}
                            {m._error && <span className="fm-error-tip" title={m._error}> ⚠</span>}
                          </td>
                          <td>
                            <button
                              className="btn btn--ghost btn--sm"
                              onClick={() => ingestIds([m.id])}
                              disabled={ingesting}
                            >
                              {m.ingested ? "Re-ingest" : "Ingest"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
    </main>
  );
}
