import { useState, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

const ACCEPT = ".pdf,.txt,.md";

function FileDropZone({ file, onFileChange }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) onFileChange(dropped);
  }

  return (
    <div
      className={`drop-zone ${dragging ? "drop-zone--over" : ""} ${file ? "drop-zone--has-file" : ""}`}
      onClick={() => inputRef.current.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => e.target.files[0] && onFileChange(e.target.files[0])}
      />
      {file ? (
        <div className="drop-zone__file">
          <span className="drop-zone__icon">📄</span>
          <span className="drop-zone__name">{file.name}</span>
          <span className="drop-zone__size">{(file.size / 1024).toFixed(1)} KB</span>
        </div>
      ) : (
        <div className="drop-zone__prompt">
          <span className="drop-zone__icon">⬆️</span>
          <p className="drop-zone__text">Click or drag a file here</p>
          <p className="drop-zone__hint">Supports .pdf · .txt · .md</p>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    idle:     { label: "Idle",       cls: "badge--idle" },
    loading:  { label: "Uploading…", cls: "badge--loading" },
    success:  { label: "Success",    cls: "badge--success" },
    error:    { label: "Error",      cls: "badge--error" },
  };
  const { label, cls } = map[status] ?? map.idle;
  return <span className={`badge ${cls}`}>{label}</span>;
}

export default function UploadPage() {
  const [file, setFile]               = useState(null);
  const [source, setSource]           = useState("");
  const [chunkSize, setChunkSize]     = useState("1200");
  const [chunkOverlap, setChunkOverlap] = useState("250");
  const [status, setStatus]           = useState("idle");
  const [result, setResult]           = useState(null);
  const [errorMsg, setErrorMsg]       = useState("");

  function handleFileChange(f) {
    setFile(f);
    if (!source) setSource(f.name);
    setResult(null);
    setStatus("idle");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) return;

    setStatus("loading");
    setResult(null);
    setErrorMsg("");

    const fd = new FormData();
    fd.append("file", file);
    fd.append("source", source || file.name);
    fd.append("chunkSize", chunkSize);
    fd.append("chunkOverlap", chunkOverlap);

    try {
      const res = await fetch(`${API_BASE}/ingest`, { method: "POST", body: fd });
      const json = await res.json();

      if (!res.ok) {
        setStatus("error");
        setErrorMsg(json.error ?? "Unknown error");
        return;
      }

      setStatus("success");
      setResult(json);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err.message);
    }
  }

  function handleReset() {
    setFile(null);
    setSource("");
    setChunkSize("1200");
    setChunkOverlap("250");
    setStatus("idle");
    setResult(null);
    setErrorMsg("");
  }

  return (
    <div className="page">
      <header className="header">
        <div className="header__logo">⚡</div>
        <h1 className="header__title">RAG Ingest</h1>
        <StatusBadge status={status} />
      </header>

      <main className="main">
        <form className="card" onSubmit={handleSubmit}>
          <h2 className="card__title">Upload to Qdrant</h2>
          <p className="card__subtitle">
            File → parse → chunk → Voyage embeddings → Qdrant
          </p>

          <div className="field">
            <label className="label">File <span className="required">*</span></label>
            <FileDropZone file={file} onFileChange={handleFileChange} />
          </div>

          <div className="field">
            <label className="label" htmlFor="source">Source name</label>
            <input
              id="source"
              className="input"
              type="text"
              placeholder="e.g. investment-memo.pdf"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <span className="hint">Human-readable label stored in Qdrant payload</span>
          </div>

          <div className="row">
            <div className="field">
              <label className="label" htmlFor="chunkSize">Chunk size</label>
              <input
                id="chunkSize"
                className="input"
                type="number"
                min="100"
                max="4000"
                value={chunkSize}
                onChange={(e) => setChunkSize(e.target.value)}
              />
              <span className="hint">Characters per chunk (default 1200)</span>
            </div>

            <div className="field">
              <label className="label" htmlFor="chunkOverlap">Chunk overlap</label>
              <input
                id="chunkOverlap"
                className="input"
                type="number"
                min="0"
                max="1000"
                value={chunkOverlap}
                onChange={(e) => setChunkOverlap(e.target.value)}
              />
              <span className="hint">Overlap between chunks (default 250)</span>
            </div>
          </div>

          <div className="actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!file || status === "loading"}
            >
              {status === "loading" ? (
                <><span className="spinner" /> Uploading…</>
              ) : (
                "Send"
              )}
            </button>
            <button type="button" className="btn btn--ghost" onClick={handleReset}>
              Reset
            </button>
          </div>
        </form>

        {status === "success" && result && (
          <div className="result result--success">
            <div className="result__header">
              <span className="result__icon">✅</span>
              <strong>Ingested successfully</strong>
            </div>
            <dl className="result__grid">
              <dt>Document ID</dt>
              <dd><code>{result.document_id}</code></dd>
              <dt>Source</dt>
              <dd>{result.source}</dd>
              <dt>Chunks upserted</dt>
              <dd><strong>{result.chunks}</strong></dd>
            </dl>
            <details className="result__raw">
              <summary>Raw response</summary>
              <pre>{JSON.stringify(result, null, 2)}</pre>
            </details>
          </div>
        )}

        {status === "error" && (
          <div className="result result--error">
            <span className="result__icon">❌</span>
            <strong>Error:</strong> {errorMsg}
          </div>
        )}
      </main>
    </div>
  );
}
