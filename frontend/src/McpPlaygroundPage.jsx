import { useCallback, useEffect, useMemo, useState } from "react";
import {
  McpSession,
  clearMcpAuth,
  clearPkcePending,
  discoverOAuth,
  exchangeCode,
  loadMcpAuth,
  peekPkcePending,
  saveMcpAuth,
  startOAuthRedirect,
  userFromAccessToken,
  originFromMcpUrl,
  PROTOCOL_VERSION,
} from "./mcpClient.js";

const DEFAULT_MCP_URL = (() => {
  if (import.meta.env.VITE_MCP_URL) return import.meta.env.VITE_MCP_URL;
  if (typeof window === "undefined") return "https://rag.collider.vc/mcp";
  return `${window.location.origin}/mcp`;
})();

function effectiveMcpUrl(url) {
  if (typeof window === "undefined") return url;
  const { hostname, origin } = window.location;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return url;
  try {
    const u = new URL(url, origin);
    if (u.pathname === "/mcp" || u.pathname.startsWith("/mcp/")) {
      return `${origin}/mcp`;
    }
  } catch {
    /* ignore */
  }
  return url;
}

let oauthCallbackLock = null;

function schemaProperties(tool) {
  const schema = tool.inputSchema || tool.input_schema || {};
  return schema.properties || {};
}

function schemaRequired(tool) {
  const schema = tool.inputSchema || tool.input_schema || {};
  return new Set(schema.required || []);
}

function defaultArgs(tool) {
  const props = schemaProperties(tool);
  const out = {};
  for (const [key, def] of Object.entries(props)) {
    if (def.default !== undefined) out[key] = def.default;
    else if (def.type === "number" || def.type === "integer") out[key] = def.type === "integer" ? 5 : 10;
    else if (def.type === "boolean") out[key] = false;
    else if (def.type === "array") out[key] = "";
    else out[key] = "";
  }
  return out;
}

function coerceArgs(tool, raw) {
  const props = schemaProperties(tool);
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    const def = props[key] || {};
    if (val === "" || val === undefined || val === null) continue;
    if (def.type === "number" || def.type === "integer") {
      const n = Number(val);
      if (!Number.isNaN(n)) out[key] = n;
    } else if (def.type === "boolean") {
      out[key] = Boolean(val);
    } else if (def.type === "array") {
      out[key] = String(val)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function toolResultText(result) {
  if (!result) return "";
  const parts = result.content || [];
  return parts
    .map((p) => (p.type === "text" ? p.text : JSON.stringify(p)))
    .join("\n\n");
}

const STATUS_LABEL = {
  disconnected: "Disconnected",
  discovering: "Discovering OAuth configuration…",
  registering_client: "Registering OAuth client…",
  authorizing: "Waiting for authorization…",
  exchanging_token: "Exchanging authorization code…",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Error",
};

export default function McpPlaygroundPage() {
  const [mcpUrl, setMcpUrl] = useState(() => effectiveMcpUrl(DEFAULT_MCP_URL));
  const [auth, setAuth] = useState(() => {
    const a = loadMcpAuth();
    if (!a) return null;
    return { ...a, mcpUrl: effectiveMcpUrl(a.mcpUrl || DEFAULT_MCP_URL) };
  });
  const [phase, setPhase] = useState(() =>
    loadMcpAuth()?.access_token ? "disconnected" : "disconnected",
  );
  const [handshakeOk, setHandshakeOk] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState("");
  const [logs, setLogs] = useState([]);
  const [selectedLog, setSelectedLog] = useState(null);
  const [serverInfo, setServerInfo] = useState(null);
  const [protocolVersion, setProtocolVersion] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [tools, setTools] = useState([]);
  const [selectedTool, setSelectedTool] = useState(null);
  const [args, setArgs] = useState({});
  const [toolResult, setToolResult] = useState("");
  const [toolResultRaw, setToolResultRaw] = useState(null);
  const [toolDuration, setToolDuration] = useState(null);
  const [resultView, setResultView] = useState("pretty");
  const [debugOpen, setDebugOpen] = useState(false);
  const [discovery, setDiscovery] = useState(null);
  const [successBanner, setSuccessBanner] = useState(false);

  const user = useMemo(() => {
    if (!auth?.access_token) return null;
    return userFromAccessToken(auth.access_token);
  }, [auth]);

  const pushLog = useCallback((entry) => {
    setLogs((prev) => [...prev.slice(-100), entry]);
  }, []);

  // OAuth callback — module lock survives Strict Mode remounts
  useEffect(() => {
    const path = window.location.pathname;
    if (path !== "/mcp-oauth-callback" && path !== "/callback") return;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");

    if (err) {
      setPhase("error");
      setError(`Authorization failed — ${params.get("error_description") || err}`);
      window.history.replaceState({}, "", "/");
      return;
    }
    if (!code || !state) return;

    if (oauthCallbackLock === code) return;
    oauthCallbackLock = code;

    const pending = peekPkcePending();
    if (!pending || pending.state !== state) {
      if (loadMcpAuth()?.access_token) {
        window.history.replaceState({}, "", "/");
        return;
      }
      setPhase("error");
      setError("OAuth state mismatch — click Connect again.");
      window.history.replaceState({}, "", "/");
      return;
    }

    (async () => {
      setPhase("exchanging_token");
      setError("");
      try {
        const tokens = await exchangeCode(pending.mcpUrl, {
          code,
          verifier: pending.verifier,
          redirectUri: pending.redirectUri,
          clientId: pending.clientId,
        });
        clearPkcePending();
        const next = {
          ...tokens,
          mcpUrl: pending.mcpUrl,
          client_id: pending.clientId,
          obtained_at: Date.now(),
        };
        saveMcpAuth(next);
        setAuth(next);
        setMcpUrl(pending.mcpUrl);
        setPhase("disconnected");
        window.history.replaceState({}, "", "/");
        await runHandshake(next);
      } catch (e) {
        setPhase("error");
        setError(e.message || String(e));
        setErrorDetail(String(e.stack || ""));
        window.history.replaceState({}, "", "/");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runHandshake(authOverride) {
    const a = authOverride || auth;
    if (!a?.access_token) {
      setError("Connect first.");
      setPhase("error");
      return;
    }
    setPhase("connecting");
    setError("");
    setErrorDetail("");
    setSuccessBanner(false);
    setHandshakeOk(false);
    try {
      const session = new McpSession(
        effectiveMcpUrl(a.mcpUrl || mcpUrl),
        a.access_token,
        pushLog,
      );
      const init = await session.initialize();
      setServerInfo(init?.serverInfo || null);
      setProtocolVersion(session.protocolVersion || PROTOCOL_VERSION);
      setCapabilities(session.capabilities || null);
      const listed = await session.listTools();
      setTools(listed?.tools || []);
      setHandshakeOk(true);
      setPhase("connected");
      setSuccessBanner(true);
    } catch (e) {
      setPhase("error");
      setHandshakeOk(false);
      const msg = e.message || String(e);
      if (/initialize/i.test(msg)) {
        setError(`MCP initialization failed — ${msg}`);
      } else if (/tools\/list|Tool discovery/i.test(msg)) {
        setError(`Tool discovery failed — ${msg}`);
      } else {
        setError(msg);
      }
      setErrorDetail(String(e.stack || ""));
    }
  }

  async function handleConnect() {
    setError("");
    setErrorDetail("");
    setSuccessBanner(false);
    setPhase("discovering");
    try {
      const d = await discoverOAuth(mcpUrl);
      setDiscovery(d);
      setPhase("registering_client");
      setPhase("authorizing");
      await startOAuthRedirect(effectiveMcpUrl(mcpUrl));
    } catch (e) {
      setPhase("error");
      setError(e.message || String(e));
      setErrorDetail(String(e.stack || ""));
    }
  }

  function handleDisconnect() {
    clearMcpAuth();
    oauthCallbackLock = null;
    setAuth(null);
    setTools([]);
    setServerInfo(null);
    setProtocolVersion(null);
    setCapabilities(null);
    setSelectedTool(null);
    setToolResult("");
    setToolResultRaw(null);
    setLogs([]);
    setSelectedLog(null);
    setDiscovery(null);
    setHandshakeOk(false);
    setSuccessBanner(false);
    setError("");
    setPhase("disconnected");
  }

  function handleSelectTool(tool) {
    setSelectedTool(tool);
    setArgs(defaultArgs(tool));
    setToolResult("");
    setToolResultRaw(null);
    setToolDuration(null);
  }

  async function handleRunTool() {
    if (!selectedTool || !auth?.access_token) return;
    setError("");
    setPhase("connecting");
    const started = performance.now();
    try {
      const session = new McpSession(
        effectiveMcpUrl(auth.mcpUrl || mcpUrl),
        auth.access_token,
        pushLog,
      );
      await session.initialize();
      const result = await session.callTool(
        selectedTool.name,
        coerceArgs(selectedTool, args),
      );
      setToolDuration(Math.round(performance.now() - started));
      setToolResultRaw(result);
      setToolResult(toolResultText(result) || JSON.stringify(result, null, 2));
      setPhase("connected");
      setHandshakeOk(true);
    } catch (e) {
      setPhase("error");
      setError(`Tool execution failed — ${e.message || e}`);
      setErrorDetail(String(e.stack || ""));
    }
  }

  const hasToken = Boolean(auth?.access_token);
  const connected = hasToken && handshakeOk && phase === "connected";
  const busy = ["discovering", "registering_client", "authorizing", "exchanging_token", "connecting"].includes(phase);

  return (
    <div className="mcp-page">
      <aside className="mcp-sidebar">
        <div>
          <h1 className="mcp-sidebar__title">MCP Playground</h1>
          <p className="mcp-auth-hint">Connect, inspect, and test your MCP server.</p>
        </div>

        <h2 className="mcp-section-label">MCP Configuration</h2>

        <label className="label" htmlFor="mcp-url">Server URL</label>
        <input
          id="mcp-url"
          className="input"
          value={mcpUrl}
          disabled={busy || connected}
          onChange={(e) => setMcpUrl(e.target.value.trim())}
          placeholder="https://rag.collider.vc/mcp"
        />

        <div className="mcp-auth-card">
          <div className="mcp-auth-row">
            <span className="label">Authentication</span>
            <span className="mcp-auth-type">OAuth 2.0</span>
          </div>
          <div className="mcp-auth-row">
            <span className="label">Status</span>
            <span
              className={`mcp-status ${
                connected ? "mcp-status--ok" : phase === "error" ? "mcp-status--err" : "mcp-status--off"
              }`}
            >
              <span className="mcp-status__dot" />
              {STATUS_LABEL[phase] || phase}
            </span>
          </div>
          {user?.email && (
            <div className="mcp-auth-row">
              <span className="label">User</span>
              <span className="mcp-user" title={user.email}>{user.email}</span>
            </div>
          )}

          <div className="mcp-auth-actions">
            {hasToken ? (
              <>
                <button type="button" className="btn btn--secondary" onClick={handleConnect} disabled={busy}>
                  Reconnect
                </button>
                <button type="button" className="btn btn--ghost" onClick={handleDisconnect} disabled={busy}>
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleConnect}
                disabled={busy || !mcpUrl}
              >
                Connect
              </button>
            )}
          </div>
        </div>

        <button
          type="button"
          className="btn btn--primary mcp-test-btn"
          onClick={() => runHandshake()}
          disabled={!hasToken || busy}
        >
          Test connection
        </button>

        <dl className="mcp-meta">
          <div><dt>Transport</dt><dd>Streamable HTTP</dd></div>
          <div><dt>MCP Endpoint</dt><dd>/mcp</dd></div>
          <div><dt>Authentication</dt><dd>OAuth 2.0</dd></div>
          <div><dt>Status</dt><dd>{connected ? "Connected" : hasToken ? "Authorized" : "Disconnected"}</dd></div>
          <div><dt>Authorization Server</dt><dd>{originFromMcpUrl(mcpUrl)}</dd></div>
          <div><dt>Scope</dt><dd>mcp</dd></div>
          <div><dt>Protocol</dt><dd>{protocolVersion || "—"}</dd></div>
        </dl>

        {error && (
          <div className="mcp-error">
            <div>{error}</div>
            {errorDetail && (
              <details className="mcp-error-details">
                <summary>Technical details</summary>
                <pre>{errorDetail}</pre>
              </details>
            )}
          </div>
        )}

        <button
          type="button"
          className="btn btn--ghost mcp-debug-toggle"
          onClick={() => setDebugOpen((v) => !v)}
        >
          {debugOpen ? "Hide" : "Show"} OAuth / MCP Debug
        </button>
      </aside>

      <main className="mcp-main">
        {successBanner && (
          <div className="mcp-success">✓ MCP server connected successfully</div>
        )}

        {debugOpen && (
          <section className="mcp-section mcp-debug">
            <h2>OAuth / MCP Debug</h2>
            <pre className="mcp-result">
{JSON.stringify(
  {
    protectedResourceMetadata: discovery?.prm || null,
    authorizationServerMetadata: discovery?.asMeta || null,
    registeredClientId: auth?.client_id || null,
    requestedScopes: "mcp",
    mcpProtocolVersion: protocolVersion,
    serverInfo,
    serverCapabilities: capabilities,
    clientCapabilities: {},
  },
  null,
  2,
)}
            </pre>
          </section>
        )}

        <section className="mcp-section">
          <div className="mcp-section__head">
            <h2>Available Tools</h2>
            {tools.length > 0 && <span className="mcp-chip">{tools.length} tools</span>}
          </div>

          {!connected && !hasToken && (
            <p className="mcp-empty">Connect with OAuth, then run Test connection to list tools.</p>
          )}
          {hasToken && !handshakeOk && phase !== "connecting" && (
            <p className="mcp-empty">Authorized — click Test connection to complete the MCP handshake.</p>
          )}

          <div className="mcp-tool-grid">
            {tools.map((tool) => {
              const props = schemaProperties(tool);
              const required = schemaRequired(tool);
              const active = selectedTool?.name === tool.name;
              return (
                <article
                  key={tool.name}
                  className={`mcp-tool-card ${active ? "mcp-tool-card--active" : ""}`}
                >
                  <h3>{tool.name}</h3>
                  <p>{tool.description || "No description"}</p>
                  {Object.keys(props).length > 0 && (
                    <ul className="mcp-params">
                      <li className="mcp-params__head">Parameters</li>
                      {Object.entries(props).map(([key, def]) => (
                        <li key={key}>
                          <code>{key}</code>
                          <span> {def.type || "any"}</span>
                          <span className="mcp-param-req">
                            {required.has(key) ? " Required" : " Optional"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => handleSelectTool(tool)}
                  >
                    Test tool
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mcp-section">
          <div className="mcp-section__head">
            <h2>Tool Playground</h2>
            {selectedTool && <span className="mcp-chip">Tool: {selectedTool.name}</span>}
          </div>

          {!selectedTool ? (
            <p className="mcp-empty">Select a tool to run it here.</p>
          ) : (
            <div className="mcp-play-grid">
              <div className="mcp-play-form">
                {Object.entries(schemaProperties(selectedTool)).map(([key, def]) => (
                  <label key={key} className="field">
                    <span className="label">
                      {key}
                      {schemaRequired(selectedTool).has(key) && (
                        <span className="required"> *</span>
                      )}
                      <span className="hint"> {def.type || "string"}</span>
                    </span>
                    {def.type === "boolean" ? (
                      <input
                        type="checkbox"
                        checked={Boolean(args[key])}
                        onChange={(e) =>
                          setArgs((a) => ({ ...a, [key]: e.target.checked }))
                        }
                      />
                    ) : (
                      <input
                        className="input"
                        value={args[key] ?? ""}
                        placeholder={def.description || key}
                        onChange={(e) =>
                          setArgs((a) => ({ ...a, [key]: e.target.value }))
                        }
                      />
                    )}
                  </label>
                ))}
                {Object.keys(schemaProperties(selectedTool)).length === 0 && (
                  <p className="hint">This tool takes no parameters.</p>
                )}
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleRunTool}
                  disabled={busy || !hasToken}
                >
                  Run tool
                </button>

                {(toolResult || toolResultRaw) && (
                  <div className="mcp-result-wrap">
                    <div className="mcp-result-toolbar">
                      <span className="label">Response</span>
                      <div className="mcp-result-tabs">
                        <button
                          type="button"
                          className={resultView === "pretty" ? "active" : ""}
                          onClick={() => setResultView("pretty")}
                        >
                          Pretty
                        </button>
                        <button
                          type="button"
                          className={resultView === "raw" ? "active" : ""}
                          onClick={() => setResultView("raw")}
                        >
                          Raw JSON
                        </button>
                      </div>
                      {toolDuration != null && (
                        <span className="hint">Duration {toolDuration} ms</span>
                      )}
                    </div>
                    <pre className="mcp-result">
                      {resultView === "raw"
                        ? JSON.stringify(toolResultRaw, null, 2)
                        : toolResult}
                    </pre>
                  </div>
                )}
              </div>

              <div className="mcp-logs">
                <div className="mcp-logs__title">— Logs</div>
                <div className="mcp-logs__body">
                  {logs.length === 0 && (
                    <div className="mcp-logs__empty">No requests yet.</div>
                  )}
                  {logs.map((l, i) => (
                    <button
                      type="button"
                      key={`${l.ts}-${i}`}
                      className={`mcp-log ${l.ok ? "" : "mcp-log--err"} ${
                        selectedLog === i ? "mcp-log--active" : ""
                      }`}
                      onClick={() => setSelectedLog(i)}
                    >
                      <span className="mcp-log__ts">{l.ts}</span>
                      <span className="mcp-log__method">{l.method}</span>
                      <span className="mcp-log__detail">
                        {l.status != null ? l.status : l.detail}
                        {l.durationMs != null ? ` · ${l.durationMs}ms` : ""}
                      </span>
                    </button>
                  ))}
                </div>
                {selectedLog != null && logs[selectedLog] && (
                  <pre className="mcp-log-detail">
{JSON.stringify(
  {
    request: logs[selectedLog].request || null,
    response: logs[selectedLog].response || null,
  },
  null,
  2,
)}
                  </pre>
                )}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
