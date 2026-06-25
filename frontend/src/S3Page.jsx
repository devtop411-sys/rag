import { useState, useEffect, useRef } from "react";

const API_BASE    = import.meta.env.VITE_API_URL ?? "";
const API_KEY     = import.meta.env.VITE_API_KEY ?? "";
const authHeaders = API_KEY ? { "x-api-key": API_KEY } : {};

const STATUS_LABEL = {
  uploaded:  { label: "Uploaded",   cls: "badge--idle" },
  uploading: { label: "Uploading…", cls: "badge--loading" },
  ingesting: { label: "Ingesting…", cls: "badge--loading" },
  ingested:  { label: "Ingested",   cls: "badge--success" },
  failed:    { label: "Failed",     cls: "badge--error" },
  duplicate: { label: "Duplicate",  cls: "badge--error" },
};

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function S3Page() {
  const [files, setFiles]         = useState([]);       // { key, fileName, size, lastModified, status }
  const [selected, setSelected]   = useState(new Set());
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const inputRef                  = useRef(null);

  useEffect(() => { loadFiles(); }, []);

  async function loadFiles() {
    setLoading(true);
    setError("");
    try {
      const res  = await fetch(`${API_BASE}/api/s3/files`, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load files");
      setFiles(data.files.map((f) => ({ ...f, status: "uploaded" })));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(e) {
    const picked = Array.from(e.target.files);
    if (!picked.length) return;
    e.target.value = "";

    const placeholders = picked.map((f) => ({
      key: `__pending__${f.name}`,
      fileName: f.name,
      size: f.size,
      lastModified: new Date().toISOString(),
      status: "uploading",
    }));
    setFiles((prev) => [...placeholders, ...prev]);

    try {
      const form = new FormData();
      picked.forEach((f) => form.append("files", f));

      const res  = await fetch(`${API_BASE}/api/s3/upload`, {
        method:  "POST",
        headers: { ...authHeaders },
        body:    form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");

      const resultMap = Object.fromEntries(data.files.map((r) => [r.fileName, r]));
      setFiles((prev) =>
        prev.map((f) => {
          if (f.status !== "uploading") return f;
          const r = resultMap[f.fileName];
          if (!r)            return { ...f, status: "failed",    error: "No result from server" };
          if (r.duplicate)   return { ...f, status: "duplicate", error: "Already exists in S3" };
          return { ...f, key: r.key, status: "uploaded" };
        }),
      );
    } catch (err) {
      setFiles((prev) =>
        prev.map((f) => f.status === "uploading" ? { ...f, status: "failed", error: err.message } : f),
      );
      setError(err.message);
    }
  }

  async function handleIngest() {
    const keys = [...selected];
    if (!keys.length) return;

    setSelected(new Set());
    setFiles((prev) =>
      prev.map((f) => keys.includes(f.key) ? { ...f, status: "ingesting" } : f),
    );

    try {
      const res  = await fetch(`${API_BASE}/api/ingest/s3`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body:    JSON.stringify({ files: keys.map((key) => ({ key })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Ingest failed");

      const resultMap = Object.fromEntries(data.results.map((r) => [r.key, r]));
      setFiles((prev) =>
        prev.map((f) => {
          const r = resultMap[f.key];
          if (!r) return f;
          return { ...f, status: (r.status === "ingested" || r.status === "skipped") ? "ingested" : "failed", error: r.error };
        }),
      );
    } catch (err) {
      setFiles((prev) =>
        prev.map((f) => keys.includes(f.key) ? { ...f, status: "failed", error: err.message } : f),
      );
    }
  }

  async function handleDelete(key) {
    if (!confirm(`Delete "${files.find((f) => f.key === key)?.fileName}"?`)) return;
    setFiles((prev) => prev.filter((f) => f.key !== key));
    setSelected((prev) => { const s = new Set(prev); s.delete(key); return s; });
    try {
      await fetch(`${API_BASE}/api/s3/file`, {
        method:  "DELETE",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body:    JSON.stringify({ key }),
      });
    } catch { /* already removed from UI */ }
  }

  function toggleSelect(key) {
    setSelected((prev) => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return s;
    });
  }

  function toggleAll() {
    const selectable = files.filter((f) => f.status === "uploaded" || f.status === "ingested").map((f) => f.key);
    if (selected.size === selectable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable));
    }
  }

  const selectable = files.filter((f) => f.status === "uploaded" || f.status === "ingested");
  const allChecked = selectable.length > 0 && selected.size === selectable.length;

  return (
    <div className="page">
      <header className="header">
        <div className="header__logo">⚡</div>
        <h1 className="header__title">File Manager</h1>
      </header>

      <main className="main">
        <div className="fm-toolbar">
          <button className="btn btn--primary" onClick={() => inputRef.current.click()}>
            Upload files
          </button>
          <input ref={inputRef} type="file" multiple accept=".pdf,.txt,.md,.docx" hidden onChange={handleUpload} />
          <button
            className="btn btn--primary"
            disabled={selected.size === 0}
            onClick={handleIngest}
          >
            Ingest selected {selected.size > 0 && `(${selected.size})`}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={loadFiles} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {error && (
          <div className="result result--error" style={{ maxWidth: 700 }}>
            <span className="result__icon">❌</span>
            <span>{error}</span>
          </div>
        )}

        <div className="fm-card">
          {files.length === 0 && !loading && (
            <p className="fm-empty">No files yet. Upload some files to get started.</p>
          )}

          {files.length > 0 && (
            <table className="fm-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={toggleAll}
                      className="fm-checkbox"
                    />
                  </th>
                  <th>File name</th>
                  <th>Size</th>
                  <th>Uploaded</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const st = STATUS_LABEL[f.status] ?? STATUS_LABEL.uploaded;
                  const canSelect = f.status === "uploaded" || f.status === "ingested";
                  return (
                    <tr key={f.key} className={selected.has(f.key) ? "fm-row--selected" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(f.key)}
                          onChange={() => toggleSelect(f.key)}
                          disabled={!canSelect}
                          className="fm-checkbox"
                        />
                      </td>
                      <td className="fm-filename" title={f.fileName}>{f.fileName}</td>
                      <td className="fm-meta">{formatSize(f.size)}</td>
                      <td className="fm-meta">
                        {f.lastModified ? new Date(f.lastModified).toLocaleDateString() : "—"}
                      </td>
                      <td>
                        <span className={`badge ${st.cls}`}>{st.label}</span>
                        {f.error && <span className="fm-error-tip" title={f.error}> ⚠</span>}
                      </td>
                      <td>
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => handleDelete(f.key)}
                          disabled={f.status === "uploading" || f.status === "ingesting"}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
