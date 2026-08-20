import { useState, useEffect, useCallback } from "react";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";

const API_BASE    = import.meta.env.VITE_API_URL ?? "";
const API_KEY     = import.meta.env.VITE_API_KEY ?? "";
const DRIVE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID ||
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  "";

const authHeaders = API_KEY ? { "x-api-key": API_KEY } : {};
const TOKEN_KEY   = "collider_drive_token";
const EXP_KEY     = "collider_drive_exp";
const ACCOUNT_KEY = "collider_drive_account";

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
    sessionStorage.removeItem(ACCOUNT_KEY);
    return "";
  }
  return token;
}

function readStoredAccount() {
  try { return JSON.parse(sessionStorage.getItem(ACCOUNT_KEY) ?? "null"); }
  catch { return null; }
}

function driveHeaders(token) {
  return {
    ...authHeaders,
    ...(token ? { "x-google-access-token": token } : {}),
  };
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
  const [token, setToken]         = useState(readStoredToken);
  const [account, setAccount]     = useState(readStoredAccount);
  const [files, setFiles]         = useState([]);
  const [selected, setSelected]   = useState(new Set());
  const [path, setPath]           = useState([{ id: "root", name: "My Drive" }]);
  const [search, setSearch]       = useState("");
  const [pageTokens, setPageTokens] = useState([""]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextPageToken, setNextPageToken] = useState(null);
  const [busy, setBusy]           = useState("");
  const [error, setError]         = useState("");

  const folderId = path[path.length - 1]?.id ?? "root";

  const persistToken = useCallback((accessToken, expiresIn, accountInfo) => {
    const exp = Date.now() + Math.max(60, Number(expiresIn) || 3600) * 1000;
    sessionStorage.setItem(TOKEN_KEY, accessToken);
    sessionStorage.setItem(EXP_KEY, String(exp));
    if (accountInfo) sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(accountInfo));
    setToken(accessToken);
    if (accountInfo) setAccount(accountInfo);
  }, []);

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXP_KEY);
    sessionStorage.removeItem(ACCOUNT_KEY);
    setToken("");
    setAccount(null);
    setFiles([]);
    setSelected(new Set());
  }, []);

  const connect = useGoogleLogin({
    flow: "implicit",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    onSuccess: (resp) => {
      persistToken(resp.access_token, resp.expires_in);
      setError("");
    },
    onError: () => setError("Google Drive authorization failed."),
  });

  const loadFiles = useCallback(async (opts = {}) => {
    const accessToken = opts.token ?? token;
    if (!accessToken) return;

    const nextFolder = opts.folderId ?? folderId;
    const nextSearch = opts.search ?? search;
    const nextPage   = opts.pageToken ?? "";

    setBusy("files");
    setError("");
    try {
      const params = new URLSearchParams({
        folderId: nextFolder,
        limit: "50",
      });
      if (nextSearch.trim()) params.set("search", nextSearch.trim());
      if (nextPage) params.set("pageToken", nextPage);

      const res  = await fetch(`${API_BASE}/api/drive/files?${params}`, {
        headers: driveHeaders(accessToken),
      });
      const data = await res.json();
      if (res.status === 401) {
        clearSession();
        throw new Error(data.error ?? "Google Drive authorization expired. Please reconnect.");
      }
      if (!res.ok) throw new Error(data.error ?? "Failed to load Drive files");

      setFiles(data.files ?? []);
      setNextPageToken(data.nextPageToken ?? null);
      setSelected(new Set());

      if (!account) {
        try {
          const s = await fetch(`${API_BASE}/api/drive/status`, {
            headers: driveHeaders(accessToken),
          });
          const status = await s.json();
          if (s.ok && status.account) {
            sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(status.account));
            setAccount(status.account);
          }
        } catch { /* listing already succeeded */ }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }, [token, folderId, search, account, clearSession]);

  useEffect(() => {
    if (token) loadFiles({ pageToken: pageTokens[pageIndex] ?? "" });
    // folder/page changes should refetch; search is applied explicitly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, folderId, pageIndex]);

  function openFolder(folder) {
    setPath((prev) => {
      if (search.trim()) return [{ id: "root", name: "My Drive" }, { id: folder.id, name: folder.name }];
      return [...prev, { id: folder.id, name: folder.name }];
    });
    setSearch("");
    setPageTokens([""]);
    setPageIndex(0);
    setNextPageToken(null);
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
    if (pageIndex === 0) {
      loadFiles({ search, pageToken: "" });
    } else {
      setPageIndex(0);
    }
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

  async function ingestIds(ids) {
    if (!ids.length || !token) return;
    setError("");
    setFiles((prev) =>
      prev.map((f) => ids.includes(f.id) ? { ...f, _status: "ingesting" } : f)
    );
    try {
      const res  = await fetch(`${API_BASE}/api/drive/ingest`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...driveHeaders(token) },
        body:    JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (res.status === 401) {
        clearSession();
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

  if (!token) {
    return (
      <main className="main">
        {error && (
          <div className="result result--error" style={{ maxWidth: 700 }}>
            <span className="result__icon">❌</span>
            <span>{error}</span>
          </div>
        )}
        <div className="fm-card" style={{ padding: 20 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 520 }}>
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
      {error && (
        <div className="result result--error" style={{ maxWidth: 700 }}>
          <span className="result__icon">❌</span>
          <span>{error}</span>
        </div>
      )}

      <div className="fm-card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <strong>Google Drive</strong>
              <span className="badge badge--success">Connected</span>
            </div>
            <span className="fm-meta">
              Account: {account?.email ?? account?.name ?? "connected"}
            </span>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={clearSession}>
            Disconnect
          </button>
        </div>
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
            {search.trim() ? "No matching files." : "This folder is empty."}
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
