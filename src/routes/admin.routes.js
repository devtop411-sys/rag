import { Router } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { getUsers, updateUserRole } from "../controllers/admin.controller.js";

const router = Router();

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

router.get("/api/admin/users",      requireApiKey, requireAuth, requireAdmin, getUsers);
router.put("/api/admin/users/role",  requireApiKey, requireAuth, requireAdmin, updateUserRole);

export default router;
