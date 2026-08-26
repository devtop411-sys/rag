import { useState, useEffect, useCallback, useRef } from "react";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";

const API_BASE    = import.meta.env.VITE_API_URL ?? "";
const API_KEY     = import.meta.env.VITE_API_KEY ?? "";
const DRIVE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID ||
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  "";

const authHeaders = API_KEY ? { "x-api-key": API_KEY } : {};
const jsonHeaders = { "Content-Type": "application/json", ...authHeaders };

const TOKEN_KEY = "collider_drive_token";
const EXP_KEY   = "collider_drive_exp";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";


const RENEW_LEAD_MS = 5 * 60 * 1000;

const ROOTS = [
  { id: "root",         name: "My Drive" },
  { id: "sharedWithMe", name: "Shared with me" },
];

const DEFAULT_SETTINGS = {
  enabled:           false,
  frequency_minutes: 60,
  reingest_modified: true,
};

function formatSize(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "—";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function readStoredToken() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const exp   = Number(sessionStorage.getItem(EXP_KEY) || 0);
  if (!token || Date.now() >= exp - 30_000) {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXP_KEY);
    return { token: "", exp: 0 };
  }
  return { token, exp };
}

export default function DrivePage() {
  if (!DRIVE_CLIENT_ID) {
    return (
      <main className="main">
        <div className="fm-card" style={{ padding: 20 }}>
          <strong>Google Drive is not configured</strong>
          <p className="fm-meta" style={{ margin: "8px 0 0" }}>
            Set <code>VITE_GOOGLE_DRIVE_CLIENT_ID</code> (or{" "}
            <code>VITE_GOOGLE_CLIENT_ID</code>) and enable the Google Drive API
            on that OAuth client.
          </p>
        </div>
      </main>
    );
  }

  return (
    <GoogleOAuthProvider clientId={DRIVE_CLIENT_ID} locale="en">
      <DrivePageInner />
    </GoogleOAuthProvider>
  );
}

function DrivePageInner() {
  const stored = readStoredToken();
  const [token, setToken]         = useState(stored.token);
  const [tokenExp, setTokenExp]   = useState(stored.exp);
  const [conn, setConn]           = useState(null);
  const [settings, setSettings]   = useState(DEFAULT_SETTINGS);
  const [files, setFiles]         = useState([]);
  const [selected, setSelected]   = useState(new Set());
  const [path, setPath]           = useState([ROOTS[0]]);
  const [search, setSearch]       = useState("");
  const [pageTokens, setPageTokens] = useState([""]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextPageToken, setNextPageToken] = useState(null);
  const [busy, setBusy]           = useState("");
  const [error, setError]         = useState("");
  const [notice, setNotice]       = useState("");

  const connected     = Boolean(token) || Boolean(conn?.connected);
  const folderId      = path[path.length - 1]?.id ?? "root";
  const currentFolder = path[path.length - 1] ?? ROOTS[0];
  const activeRootId  = path[0]?.id ?? "root";
  const watchFolders  = conn?.watch_folders ?? ROOTS;
  const isWatching    = watchFolders.some((f) => f.id === folderId) && !search.trim();

  const driveHeaders = useCallback((extra = {}) => ({
    ...extra,
    ...(token ? { "x-google-access-token": token } : {}),
  }), [token]);

  const loadStatus = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/api/drive/status`, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load Drive status");
      setConn(data);
      setSettings({ ...DEFAULT_SETTINGS, ...data.auto_sync });
      return data;
    } catch (err) {
      setError(err.message);
      setConn({ connected: false });
      return null;
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const pushToken = useCallback(async (accessToken, expiresIn) => {
    try {
      const res = await fetch(`${API_BASE}/api/drive/connect`, {
        method:  "POST",
        headers: jsonHeaders,
        body:    JSON.stringify({ access_token: accessToken, expires_in: expiresIn }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to register the connection");
      setConn(data);
      setSettings({ ...DEFAULT_SETTINGS, ...data.auto_sync });
    } catch (err) {
      // Browsing still works on the local token; only background sync suffers.
      console.error("[drive] could not register token for auto-ingest:", err.message);
    }
  }, []);

  const acceptToken = useCallback((accessToken, expiresIn) => {
    const ttl = Math.max(60, Number(expiresIn) || 3600);
    const exp = Date.now() + ttl * 1000;
    sessionStorage.setItem(TOKEN_KEY, accessToken);
    sessionStorage.setItem(EXP_KEY, String(exp));
    setToken(accessToken);
    setTokenExp(exp);
    setError("");
    pushToken(accessToken, ttl);
  }, [pushToken]);

  const connect = useGoogleLogin({
    flow:  "implicit",
    scope: DRIVE_SCOPE,
    onSuccess: (resp) => acceptToken(resp.access_token, resp.expires_in),
    onError: () => setError("Google Drive authorization failed."),
  });

  const renewToken = useGoogleLogin({
    flow:   "implicit",
    scope:  DRIVE_SCOPE,
    prompt: "",
    onSuccess: (resp) => acceptToken(resp.access_token, resp.expires_in),
    onError: () => { /* the next scheduled attempt or a manual reconnect covers it */ },
  });

  const renewRef = useRef(renewToken);
  renewRef.current = renewToken;

  const pushedOnMount = useRef(false);
  useEffect(() => {
    if (pushedOnMount.current || !token || !tokenExp) return;
    pushedOnMount.current = true;
    pushToken(token, Math.round((tokenExp - Date.now()) / 1000));
  }, [token, tokenExp, pushToken]);

  useEffect(() => {
    if (!tokenExp) return;
    const delay = Math.max(1000, tokenExp - Date.now() - RENEW_LEAD_MS);
    const timer = setTimeout(() => renewRef.current(), delay);
    return () => clearTimeout(timer);
  }, [tokenExp]);

  function clearLocalToken() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXP_KEY);
    setToken("");
    setTokenExp(0);
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect Google Drive? Ingested files stay in the knowledge base.")) return;
    setBusy("connect");
    try {
      const res  = await fetch(`${API_BASE}/api/drive/disconnect`, {
        method: "POST", headers: jsonHeaders,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to disconnect");
      setConn(data);
      clearLocalToken();
      setFiles([]);
      setSelected(new Set());
      setNotice("Google Drive disconnected.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  const loadFiles = useCallback(async (opts = {}) => {
    const nextFolder = opts.folderId ?? folderId;
    const nextSearch = opts.search ?? search;
    const nextPage   = opts.pageToken ?? "";

    setBusy("files");
    setError("");
    try {
      const params = new URLSearchParams({ folderId: nextFolder, limit: "50" });
      if (nextSearch.trim()) params.set("search", nextSearch.trim());
      if (nextPage) params.set("pageToken", nextPage);

      const res  = await fetch(`${API_BASE}/api/drive/files?${params}`, {
        headers: driveHeaders(authHeaders),
      });
      const data = await res.json();
      if (res.status === 401) {
        clearLocalToken();
        setConn((c) => ({ ...(c ?? {}), connected: false }));
        throw new Error(data.error ?? "Google Drive authorization expired. Please reconnect.");
      }
      if (!res.ok) throw new Error(data.error ?? "Failed to load Drive files");

      setFiles(data.files ?? []);
      setNextPageToken(data.nextPageToken ?? null);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }, [folderId, search, driveHeaders]);

  useEffect(() => {
    if (connected) loadFiles({ pageToken: pageTokens[pageIndex] ?? "" });

  }, [connected, folderId, pageIndex]);

  function resetBrowsing() {
    setSearch("");
    setPageTokens([""]);
    setPageIndex(0);
    setNextPageToken(null);
  }

  function selectRoot(root) {
    if (root.id === activeRootId && path.length === 1 && !search.trim()) return;
    setPath([root]);
    resetBrowsing();
  }

  function openFolder(folder) {
    setPath((prev) => {
      // Search spans every root, so anchor the result under whichever root is
      // active rather than assuming My Drive.
      const base = prev[0] ?? ROOTS[0];
      if (search.trim()) return [base, { id: folder.id, name: folder.name }];
      return [...prev, { id: folder.id, name: folder.name }];
    });
    resetBrowsing();
  }

  function goToCrumb(index) {
    setPath((prev) => prev.slice(0, index + 1));
    setSearch("");
    setPageTokens([""]);
    setPageIndex(0);
    setNextPageToken(null);
  }

  function runSearch() {
    setPageTokens([""]);
    if (pageIndex === 0) loadFiles({ search, pageToken: "" });
    else setPageIndex(0);
  }

  function goNext() {
    if (!nextPageToken) return;
    setPageTokens((prev) => {
      const next = prev.slice(0, pageIndex + 1);
      next.push(nextPageToken);
      return next;
    });
    setPageIndex((i) => i + 1);
  }

  function goPrev() {
    if (pageIndex <= 0) return;
    setPageIndex((i) => i - 1);
  }

  async function saveSettings(overrides = {}, notice = "") {
    setBusy("settings");
    setError("");
    try {
      const res  = await fetch(`${API_BASE}/api/drive/settings`, {
        method:  "PUT",
        headers: driveHeaders(jsonHeaders),
        body:    JSON.stringify({ auto_sync: settings, ...overrides }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save settings");
      setSettings({ ...DEFAULT_SETTINGS, ...data.auto_sync });
      setConn((c) => ({ ...(c ?? {}), auto_sync: data.auto_sync, watch_folders: data.watch_folders }));
      setNotice(notice || "Auto-ingest settings saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  function watchCurrentFolder() {
    const next = [...watchFolders, { id: currentFolder.id, name: currentFolder.name }];
    saveSettings({ watch_folders: next }, `Auto-ingest now also watches “${currentFolder.name}”.`);
  }

  function unwatchFolder(folder) {
    const next = watchFolders.filter((f) => f.id !== folder.id);
    if (!next.length) {
      setError("At least one folder has to stay watched.");
      return;
    }
    saveSettings({ watch_folders: next }, `Auto-ingest no longer watches “${folder.name}”.`);
  }

  async function handleSyncNow() {
    setBusy("sync");
    setError("");
    setNotice("");
    try {
      const res  = await fetch(`${API_BASE}/api/drive/sync`, {
        method: "POST", headers: driveHeaders(jsonHeaders),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.reason === "not_connected"
            ? "Google Drive is not connected on the server. Click Connect Google Drive again."
            : data.error ?? "Sync failed"
        );
      }

      setNotice(data.already_running ? "A sync is already running…" : "Sync started…");

      let summary = "Sync finished.";
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));

        const s = await fetch(`${API_BASE}/api/drive/sync`, { headers: jsonHeaders });
        const { sync } = await s.json();
        if (!sync) break;

        if (sync.running) {
          const p = sync.progress;
          setNotice(p?.current
            ? `Syncing — ingesting “${p.current}” (${p.done ?? 0}/${p.total ?? "?"}` +
              (p.pending != null ? `, ${p.pending} pending` : "") + ")…"
            : "Scanning Drive…");
          continue;
        }

        if (sync.error) throw new Error(sync.error);
        const r = sync.result ?? {};
        if (r.reason === "not_connected") throw new Error("Google Drive is not connected.");
        summary =
          `Sync complete — ingested ${r.ingested ?? 0} file(s)` +
          (r.deferred ? `, ${r.deferred} queued for the next run` : "") +
          (r.skipped ? `, ${r.skipped} skipped as unreadable` : "") +
          (r.failed ? `, ${r.failed} failed and will be retried` : "") +
          ` (scanned ${r.scanned ?? 0}).` +
          (r.auth_expired ? " Sign-in expired mid-run — reconnect to continue." : "") +
          (r.truncated ? ` Only the first ${r.maxFiles} files were scanned.` : "");
        break;
      }

      setNotice(summary);
      await loadStatus();
      await loadFiles({ pageToken: pageTokens[pageIndex] ?? "" });
    } catch (err) {
      setError(err.message);
      setNotice("");
    } finally {
      setBusy("");
    }
  }

  async function ingestIds(ids) {
    if (!ids.length) return;
    setError("");
    setFiles((prev) =>
      prev.map((f) => ids.includes(f.id) ? { ...f, _status: "ingesting" } : f)
    );
    try {
      const res  = await fetch(`${API_BASE}/api/drive/ingest`, {
        method:  "POST",
        headers: driveHeaders(jsonHeaders),
        body:    JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (res.status === 401) {
        clearLocalToken();
        setConn((c) => ({ ...(c ?? {}), connected: false }));
        throw new Error(data.error ?? "Google Drive authorization expired. Please reconnect.");
      }
      if (!res.ok) throw new Error(data.error ?? "Ingest failed");

      const map = Object.fromEntries((data.results ?? []).map((r) => [r.id, r]));
      setFiles((prev) => prev.map((f) => {
        const r = map[f.id];
        if (!r) return { ...f, _status: undefined };
        if (r.status === "ingested") {
          return { ...f, _status: undefined, ingested: true, chunks: r.chunks, _error: undefined };
        }
        return { ...f, _status: undefined, _error: r.error };
      }));
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
      setFiles((prev) =>
        prev.map((f) => ids.includes(f.id) ? { ...f, _status: undefined } : f)
      );
    }
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }

  const selectable = files.filter((f) => f.ingestible && f._status !== "ingesting");
  const allChecked = selectable.length > 0 && selectable.every((f) => selected.has(f.id));

  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(selectable.map((f) => f.id)));
  }

  const ingestedCount = files.filter((f) => f.ingested).length;

  const banners = (
    <>
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
    </>
  );

  if (conn === null) {
    return <main className="main"><p className="fm-empty">Loading…</p></main>;
  }

  if (!connected) {
    return (
      <main className="main">
        {banners}
        <div className="fm-card" style={{ padding: 20 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
            <div>
              <strong>Google Drive</strong>
              <p className="fm-meta" style={{ margin: "4px 0 0" }}>
                Connect your Google account to browse Drive files and ingest
                them into the knowledge base. PDFs, Docs, Sheets, Slides, Word,
                Markdown, and text files are supported.
              </p>
            </div>
            <div>
              <button className="btn btn--primary" onClick={() => connect()}>
                Connect Google Drive
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      {banners}

      <div className="fm-card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <strong>Google Drive</strong>
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
      </div>

      <div className="fm-card" style={{ padding: 20, marginBottom: 20 }}>
        <strong>Automatic ingestion</strong>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12, maxWidth: 560 }}>
          <span className="fm-meta">
            Watched folders are scanned recursively. Every file that is not in the
            knowledge base yet gets ingested.
            {conn.unusable_count
              ? ` ${conn.unusable_count} file(s) were skipped as unreadable and are not retried until they change in Drive.`
              : ""}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {watchFolders.map((folder) => (
              <span key={folder.id} className="fm-chip">
                {folder.name}
                <button
                  type="button"
                  className="fm-chip__remove"
                  onClick={() => unwatchFolder(folder)}
                  disabled={busy === "settings"}
                  title={`Stop auto-ingesting “${folder.name}”`}
                  aria-label={`Stop watching ${folder.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              className="fm-checkbox"
              checked={settings.enabled}
              onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
            />
            Automatically ingest new Drive files
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            Check every
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
              checked={settings.reingest_modified}
              onChange={(e) => setSettings((s) => ({ ...s, reingest_modified: e.target.checked }))}
            />
            Re-ingest files that changed in Drive
          </label>
          <span className="fm-meta">
            Google sign-in lasts about an hour, and it is refreshed while this
            page is open. Auto-ingest keeps running in the background after you
            close the tab, and pauses if nobody opens the app for over an hour —
            reopening this page resumes it.
          </span>
          <div>
            <button
              className="btn btn--primary btn--sm"
              onClick={() => saveSettings()}
              disabled={busy === "settings"}
            >
              {busy === "settings" ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      </div>

      <div className="fm-toolbar">
        {ROOTS.map((root) => (
          <button
            key={root.id}
            className={root.id === activeRootId ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
            onClick={() => selectRoot(root)}
            disabled={busy === "files"}
          >
            {root.name}
          </button>
        ))}
      </div>

      <div className="fm-toolbar">
        <nav className="fm-breadcrumb" aria-label="Drive folder">
          {path.map((crumb, i) => (
            <span key={`${crumb.id}-${i}`}>
              {i > 0 && <span className="fm-breadcrumb__sep">/</span>}
              {i === path.length - 1 ? (
                <span>{search.trim() ? "Search results" : crumb.name}</span>
              ) : (
                <button type="button" onClick={() => goToCrumb(i)}>{crumb.name}</button>
              )}
            </span>
          ))}
        </nav>
        <button
          className="btn btn--ghost btn--sm"
          onClick={watchCurrentFolder}
          disabled={isWatching || busy === "settings" || !!search.trim()}
          title="Also auto-ingest everything in this folder and its subfolders"
        >
          {isWatching ? "Watching this folder" : "Watch this folder"}
        </button>
      </div>

      <div className="fm-toolbar">
        <input
          type="text"
          className="fm-input"
          placeholder="Search Drive files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #ccc", minWidth: 220 }}
        />
        <button className="btn btn--ghost btn--sm" onClick={runSearch} disabled={busy === "files"}>
          {busy === "files" ? "Loading…" : "Search"}
        </button>
        <button
          className="btn btn--primary"
          disabled={selected.size === 0}
          onClick={() => ingestIds([...selected])}
        >
          Ingest selected {selected.size > 0 && `(${selected.size})`}
        </button>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => loadFiles({ pageToken: pageTokens[pageIndex] ?? "" })}
          disabled={busy === "files"}
        >
          Refresh
        </button>
        {files.length > 0 && (
          <span className="fm-page-info">
            {ingestedCount} of {files.filter((f) => f.ingestible).length} ingested
          </span>
        )}
      </div>

      <div className="fm-card">
        {files.length === 0 && busy !== "files" && (
          <p className="fm-empty">
            {search.trim()
              ? "No matching files."
              : folderId === "sharedWithMe"
                ? "Nothing has been shared with this account yet."
                : "This folder is empty."}
          </p>
        )}

        {files.length > 0 && (
          <table className="fm-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    className="fm-checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                  />
                </th>
                <th>Name</th>
                <th>Type</th>
                <th>Size</th>
                <th>Modified</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const ingesting = f._status === "ingesting";
                return (
                  <tr key={f.id} className={selected.has(f.id) ? "fm-row--selected" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        className="fm-checkbox"
                        checked={selected.has(f.id)}
                        onChange={() => toggleSelect(f.id)}
                        disabled={!f.ingestible || ingesting}
                      />
                    </td>
                    <td className="fm-filename" title={f.name}>
                      {f.folder ? (
                        <button type="button" className="fm-link" onClick={() => openFolder(f)}>
                          {f.name}
                        </button>
                      ) : f.webViewLink ? (
                        <a href={f.webViewLink} target="_blank" rel="noreferrer" className="fm-link">
                          {f.name}
                        </a>
                      ) : (
                        f.name
                      )}
                    </td>
                    <td className="fm-meta">{f.type}</td>
                    <td className="fm-meta">{formatSize(f.size)}</td>
                    <td className="fm-meta">{formatDate(f.modifiedTime)}</td>
                    <td>
                      {f.folder ? (
                        <span className="fm-meta">—</span>
                      ) : ingesting ? (
                        <span className="badge badge--loading">Ingesting…</span>
                      ) : f.ingested ? (
                        <span className="badge badge--success">
                          Ingested{f.chunks ? ` · ${f.chunks} chunks` : ""}
                        </span>
                      ) : (
                        <span className="badge badge--idle">Not ingested</span>
                      )}
                      {f._error && <span className="fm-error-tip" title={f._error}> ⚠</span>}
                    </td>
                    <td>
                      {f.ingestible && (
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => ingestIds([f.id])}
                          disabled={ingesting}
                        >
                          {f.ingested ? "Re-ingest" : "Ingest"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="fm-pagination">
        <button
          className="btn btn--ghost btn--sm"
          onClick={goPrev}
          disabled={pageIndex <= 0 || busy === "files"}
        >
          ← Prev
        </button>
        <span className="fm-page-info">Page {pageIndex + 1}</span>
        <button
          className="btn btn--ghost btn--sm"
          onClick={goNext}
          disabled={!nextPageToken || busy === "files"}
        >
          Next →
        </button>
      </div>
    </main>
  );
}
