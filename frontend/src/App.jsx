import { useState } from "react";
import UploadPage from "./UploadPage.jsx";
import S3Page     from "./S3Page.jsx";

export default function App() {
  const [page, setPage] = useState("s3");

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
      </nav>
      {page === "s3" ? <S3Page /> : <UploadPage />}
    </>
  );
}
