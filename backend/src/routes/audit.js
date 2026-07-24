const express = require("express");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();
router.use(authenticate);

router.get(
  "/",
  requirePermission("audit:view"),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await query(
      `SELECT a.*, u.name AS user_name, u.email AS user_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ logs: rows });
  })
);

module.exports = router;
