import { useState } from "react";
import { GoogleOAuthProvider } from "@react-oauth/google";
import LoginPage  from "./LoginPage.jsx";
import UploadPage from "./UploadPage.jsx";
import S3Page     from "./S3Page.jsx";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

function getStoredUser() {
  try { return JSON.parse(localStorage.getItem("collider_user") ?? "null"); }
  catch { return null; }
}

export default function App() {
  const [user, setUser] = useState(getStoredUser);
  const [page, setPage] = useState("s3");

  function handleLogin(userData) {
    localStorage.setItem("collider_user", JSON.stringify(userData));
    setUser(userData);
  }

  function handleLogout() {
    localStorage.removeItem("collider_user");
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
    <>
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

        <div className="nav-user">
          {user.picture && (
            <img src={user.picture} alt={user.name} className="nav-avatar" referrerPolicy="no-referrer" />
          )}
          <span className="nav-email">{user.email}</span>
          <button className="nav-signout" onClick={handleLogout}>Sign out</button>
        </div>
      </nav>

      {page === "s3" ? <S3Page /> : <UploadPage />}
    </>
  );
}
