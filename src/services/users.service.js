import { createHash } from "node:crypto";
import { qdrant } from "./qdrant.service.js";

const COLLECTION = process.env.USERS_COLLECTION || "app_users";
const DUMMY_VECTOR = [1];

let ensured = false;

async function ensureCollection() {
  if (ensured) return;
  try {
    await qdrant.getCollection(COLLECTION);
  } catch (err) {
    const is404 = err.message === "Not Found" || err.$metadata?.httpStatusCode === 404;
    if (!is404) throw err;
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: 1, distance: "Cosine" },
    });
    console.log(`[users] Created collection "${COLLECTION}"`);
  }
  ensured = true;
}

function emailToId(email) {
  return createHash("md5").update(email.toLowerCase()).digest("hex");
}

function pointIdToUuid(hex) {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export async function upsertUser({ email, name, picture }) {
  await ensureCollection();
  const id = pointIdToUuid(emailToId(email));
  let existing = null;
  try {
    const points = await qdrant.retrieve(COLLECTION, {
      ids: [id],
      with_payload: true,
      with_vector: false,
    });
    existing = points?.[0]?.payload || null;
  } catch {}

  const payload = {
    email: email.toLowerCase(),
    name:  name || existing?.name || email,
    picture: picture || existing?.picture || null,
    role:  existing?.role || "user",
    created_at: existing?.created_at || new Date().toISOString(),
    last_login: new Date().toISOString(),
  };

  await qdrant.upsert(COLLECTION, {
    wait: true,
    points: [{ id, vector: DUMMY_VECTOR, payload }],
  });

  return payload;
}

export async function getUser(email) {
  await ensureCollection();
  const id = pointIdToUuid(emailToId(email));
  try {
    const points = await qdrant.retrieve(COLLECTION, {
      ids: [id],
      with_payload: true,
      with_vector: false,
    });
    return points?.[0]?.payload || null;
  } catch {
    return null;
  }
}

export async function getUserRole(email) {
  const user = await getUser(email);
  return user?.role || "user";
}

export async function setUserRole(email, role) {
  await ensureCollection();
  const id = pointIdToUuid(emailToId(email));

  const points = await qdrant.retrieve(COLLECTION, {
    ids: [id],
    with_payload: true,
    with_vector: false,
  });
  const existing = points?.[0]?.payload;
  if (!existing) {
    const err = new Error(`User ${email} not found`);
    err.status = 404;
    throw err;
  }

  const payload = { ...existing, role };
  await qdrant.upsert(COLLECTION, {
    wait: true,
    points: [{ id, vector: DUMMY_VECTOR, payload }],
  });

  return payload;
}

export async function listUsers() {
  await ensureCollection();
  const all = [];
  let offset = null;

  do {
    const page = await qdrant.scroll(COLLECTION, {
      limit: 100,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });

    for (const point of page.points) {
      if (point.payload?.email) {
        all.push({
          email:      point.payload.email,
          name:       point.payload.name,
          picture:    point.payload.picture || null,
          role:       point.payload.role || "user",
          created_at: point.payload.created_at,
          last_login: point.payload.last_login,
        });
      }
    }
    offset = page.next_page_offset ?? null;
  } while (offset !== null);

  all.sort((a, b) => (a.last_login ?? "").localeCompare(b.last_login ?? "")).reverse();
  return all;
}
