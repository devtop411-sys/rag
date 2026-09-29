import { listUsers, setUserRole } from "../services/users.service.js";

export async function getUsers(req, res) {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateUserRole(req, res) {
  try {
    const { email, role } = req.body ?? {};
    if (!email) return res.status(400).json({ error: "email is required" });
    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "role must be 'user' or 'admin'" });
    }

    const user = await setUserRole(email.toLowerCase(), role);
    res.json({ ok: true, user });
  } catch (err) {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  }
}
