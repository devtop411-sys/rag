import { useState, useEffect } from "react";
import { API_BASE, authHeaders as getAuthHeaders, jsonHeaders as getJsonHeaders } from "./apiBase.js";

export default function AdminPage() {
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");
  const [notice, setNotice]   = useState("");

  useEffect(() => { loadUsers(); }, []);

  async function loadUsers() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/users`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load users");
      setUsers(data.users ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function changeRole(email, newRole) {
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/role`, {
        method: "PUT",
        headers: getJsonHeaders(),
        body: JSON.stringify({ email, role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update role");
      setUsers((prev) =>
        prev.map((u) => (u.email === email ? { ...u, role: newRole } : u)),
      );
      setNotice(`Role for ${email} updated to ${newRole}`);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="main">
      {error && (
        <div className="result result--error" style={{ maxWidth: 700 }}>
          <span className="result__icon">!</span>
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="result result--success" style={{ maxWidth: 700 }}>
          <span className="result__icon">OK</span>
          <span>{notice}</span>
        </div>
      )}

      <div className="fm-card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <strong>User management</strong>
          <button className="btn btn--ghost btn--sm" onClick={loadUsers} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>

        {!loading && users.length === 0 && (
          <p className="fm-meta">No users have signed in yet.</p>
        )}

        {users.length > 0 && (
          <table className="fm-table">
            <thead>
              <tr>
                <th></th>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last login</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email}>
                  <td style={{ width: 36 }}>
                    {u.picture ? (
                      <img
                        src={u.picture}
                        alt=""
                        style={{ width: 28, height: 28, borderRadius: "50%" }}
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span style={{
                        display: "inline-flex", width: 28, height: 28,
                        borderRadius: "50%", background: "var(--c-surface, #eee)",
                        alignItems: "center", justifyContent: "center", fontSize: 13,
                      }}>
                        {(u.name || u.email)[0].toUpperCase()}
                      </span>
                    )}
                  </td>
                  <td className="fm-filename">{u.name || "—"}</td>
                  <td className="fm-meta">{u.email}</td>
                  <td>
                    <span className={`badge ${u.role === "admin" ? "badge--success" : "badge--idle"}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="fm-meta">
                    {u.last_login ? new Date(u.last_login).toLocaleString() : "—"}
                  </td>
                  <td>
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u.email, e.target.value)}
                      style={{
                        padding: "4px 8px", borderRadius: 6,
                        border: "1px solid var(--c-border, #ccc)",
                        background: "var(--c-surface, #fff)",
                        color: "inherit", fontSize: 13,
                      }}
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
