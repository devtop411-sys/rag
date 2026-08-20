import { useState, useEffect } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import LoginPage  from "./LoginPage.jsx";
import UploadPage from "./UploadPage.jsx";
import S3Page     from "./S3Page.jsx";
import FirefliesPage from "./FirefliesPage.jsx";
import DrivePage  from "./DrivePage.jsx";
import McpPlaygroundPage from "./McpPlaygroundPage.jsx";
import {
  BurgerIcon,
  FolderIcon,
  UploadIcon,
  SparkIcon,
  DriveIcon,
  PuzzleIcon,
  LogoutIcon,
} from "./icons/index.jsx";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

const NAV_ITEMS = [
  { to: "/files",      label: "File Manager",   icon: FolderIcon },
  { to: "/upload",     label: "Quick Upload",   icon: UploadIcon },
  { to: "/drive",      label: "Google Drive",   icon: DriveIcon },
  { to: "/fireflies",  label: "Fireflies",      icon: SparkIcon },
  { to: "/playground", label: "MCP Playground", icon: PuzzleIcon },
];

function getStoredUser() {
  try { return JSON.parse(localStorage.getItem("collider_user") ?? "null"); }
  catch { return null; }
}

export default function App() {
  const [user, setUser] = useState(getStoredUser);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("collider_sidebar_collapsed") === "1",
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    localStorage.setItem("collider_sidebar_collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

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

  const active =
    NAV_ITEMS.find((n) => location.pathname.startsWith(n.to)) ?? NAV_ITEMS[0];

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID} locale="en">
      <div className={`shell ${collapsed ? "shell--collapsed" : ""} ${mobileOpen ? "shell--mobile-open" : ""}`}>
        <div className="shell__scrim" onClick={() => setMobileOpen(false)} />

        <aside className="sidebar">
          <div className="sidebar__brand">
            <span className="sidebar__logo">⚡</span>
            <span className="sidebar__brand-text">Collider VC</span>
          </div>

          <nav className="sidebar__nav">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `nav-item ${isActive ? "nav-item--active" : ""}`}
                title={label}
              >
                <span className="nav-item__icon"><Icon /></span>
                <span className="nav-item__label">{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="sidebar__footer">
            {user.picture && (
              <img src={user.picture} alt={user.name} className="sidebar__avatar" referrerPolicy="no-referrer" />
            )}
            <div className="sidebar__user">
              <span className="sidebar__name">{user.name ?? "Signed in"}</span>
              <span className="sidebar__email">{user.email}</span>
            </div>
            <button className="sidebar__signout" onClick={handleLogout} title="Sign out">
              <LogoutIcon />
            </button>
          </div>
        </aside>

        <div className="shell__body">
          <header className="topbar">
            <button
              className="burger"
              onClick={() => {
                if (window.matchMedia("(max-width: 860px)").matches) setMobileOpen((v) => !v);
                else setCollapsed((v) => !v);
              }}
              aria-label="Toggle navigation"
            >
              <BurgerIcon />
            </button>
            <h1 className="topbar__title">{active.label}</h1>
          </header>

          <main className="shell__content">
            <Routes>
              <Route path="/" element={<Navigate to="/files" replace />} />
              <Route path="/files" element={<S3Page />} />
              <Route path="/upload" element={<UploadPage />} />
              <Route path="/drive" element={<DrivePage />} />
              <Route path="/fireflies" element={<FirefliesPage />} />
              <Route path="/playground" element={<McpPlaygroundPage />} />
              <Route path="/mcp-oauth-callback" element={<McpPlaygroundPage />} />
              <Route path="/callback" element={<McpPlaygroundPage />} />
              <Route path="*" element={<Navigate to="/files" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </GoogleOAuthProvider>
  );
}
