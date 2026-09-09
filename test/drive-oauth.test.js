import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import app from "../src/app.js";
import { resolveDriveRedirectUri } from "../src/services/drive.state.js";

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(
  () =>
    new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
);

test("resolveDriveRedirectUri accepts the production Drive page", () => {
  assert.equal(
    resolveDriveRedirectUri("https://rag.collider.vc/drive"),
    "https://rag.collider.vc/drive",
  );
});

test("resolveDriveRedirectUri rejects a non-/drive path", () => {
  assert.throws(
    () => resolveDriveRedirectUri("https://rag.collider.vc/callback"),
    /redirect_uri/,
  );
});

test("resolveDriveRedirectUri rejects an unknown origin", () => {
  assert.throws(
    () => resolveDriveRedirectUri("https://evil.example/drive"),
    /not allowed/,
  );
});

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (process.env.API_KEY) headers["x-api-key"] = process.env.API_KEY;
  return headers;
}

test("POST /api/drive/connect without code returns 400", async () => {
  const res = await fetch(`${baseUrl}/api/drive/connect`, {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: "{}",
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Authorization code is required/);
});

test("GET /api/drive/authorize returns a Google consent URL when OAuth is configured", async () => {
  const redirect = encodeURIComponent("https://rag.collider.vc/drive");
  const res = await fetch(
    `${baseUrl}/api/drive/authorize?redirect_uri=${redirect}&state=abc`,
    { headers: apiHeaders() },
  );
  const json = await res.json();
  if (res.status !== 200) {
    assert.equal(res.status, 500);
    assert.match(json.error, /GOOGLE_CLIENT|Client Secret|Client secret/i);
    return;
  }
  assert.match(json.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.equal(json.redirect_uri, "https://rag.collider.vc/drive");
  const url = new URL(json.url);
  assert.equal(url.searchParams.get("redirect_uri"), "https://rag.collider.vc/drive");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "abc");
});
