import { useState, useEffect } from "react";
import { GoogleOAuthProvider } from "@react-oauth/google";
import LoginPage  from "./LoginPage.jsx";
import UploadPage from "./UploadPage.jsx";
import S3Page     from "./S3Page.jsx";
import McpPlaygroundPage from "./McpPlaygroundPage.jsx";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

function getStoredUser() {
  try { return JSON.parse(localStorage.getItem("collider_user") ?? "null"); }
  catch { return null; }
}

function initialPage() {
  if (typeof window === "undefined") return "s3";
  const path = window.location.pathname;
  if (path === "/mcp-oauth-callback" || path === "/callback") return "mcp";
  return "s3";
}

export default function App() {
  const [user, setUser] = useState(getStoredUser);
  const [page, setPage] = useState(initialPage);

  useEffect(() => {
    const path = window.location.pathname;
    if (path === "/mcp-oauth-callback" || path === "/callback") setPage("mcp");
  }, []);

  function handleLogin(userData) {
    localStorage.setItem("collider_user", JSON.stringify(userData));
    setUser(userData);
  }

  function handleLogout() {
    localStorage.removeItem("collider_user");
    localStorage.removeItem("collider_mcp_oauth");
    setUser(null);
  }

  if (!user) {
    return (
      <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID} locale="en">
        <LoginPage onLogin={handleLogin} />
      </GoogleOAuthProvider>
    );
  }

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID} locale="en">
      <nav className="nav-tabs">
        <button
          className={`nav-tab ${page === "s3" ? "nav-tab--active" : ""}`}
          onClick={() => setPage("s3")}
        >
          File Manager
        </button>
        <button
          className={`nav-tab ${page === "upload" ? "nav-tab--active" : ""}`}
          onClick={() => setPage("upload")}
        >
          Quick Upload
        </button>
        <button
          className={`nav-tab ${page === "mcp" ? "nav-tab--active" : ""}`}
          onClick={() => setPage("mcp")}
        >
          MCP Playground
        </button>

        <div className="nav-user">
          {user.picture && (
            <img src={user.picture} alt={user.name} className="nav-avatar" referrerPolicy="no-referrer" />
          )}
          <span className="nav-email">{user.email}</span>
          <button className="nav-signout" onClick={handleLogout}>Sign out</button>
        </div>
      </nav>

      {page === "s3" && <S3Page />}
      {page === "upload" && <UploadPage />}
      {page === "mcp" && <McpPlaygroundPage />}
    </GoogleOAuthProvider>
  );
}
