const express = require("express");
const { z } = require("zod");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

async function resolveBranchId(req) {
  if (req.user.branch_id) return req.user.branch_id;
  const { rows } = await query(`SELECT id FROM branches ORDER BY created_at ASC LIMIT 1`);
  return rows[0]?.id || null;
}

// Igual criterio que en payment_methods (ver paymentMethods.js): garantiza
// que una sucursal nueva (instalación nueva, db:reset) siempre tenga algún
// motivo de ejemplo para empezar, sin depender del orden migrate → seed.
async function ensureDefaultsSeeded(branchId) {
  const { rows } = await query(
    `SELECT 1 FROM discount_reasons WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL) LIMIT 1`,
    [branchId]
  );
  if (rows.length > 0) return;
  const defaults = ["Empleados", "Cliente frecuente", "Cortesía"];
  for (let i = 0; i < defaults.length; i++) {
    await query(`INSERT INTO discount_reasons (branch_id, label, "order") VALUES ($1,$2,$3)`, [
      branchId,
      defaults[i],
      i + 1,
    ]);
  }
}

// Lista activa: la usa el POS para armar el desplegable de motivos al
// aplicar un descuento (más la opción fija "Otro" para texto libre, que no
// vive en esta tabla).
router.get(
  "/",
  requirePermission("orders:discount"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    await ensureDefaultsSeeded(branchId);
    const { rows } = await query(
      `SELECT * FROM discount_reasons
       WHERE (branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)) AND active = TRUE
       ORDER BY "order" ASC, label ASC`,
      [branchId]
    );
    res.json({ discountReasons: rows });
  })
);

router.get(
  "/all",
  requirePermission("settings:manage"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    await ensureDefaultsSeeded(branchId);
    const { rows } = await query(
      `SELECT * FROM discount_reasons
       WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)
       ORDER BY "order" ASC, label ASC`,
      [branchId]
    );
    res.json({ discountReasons: rows });
  })
);

router.post(
  "/",
  requirePermission("settings:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ label: z.string().min(1).max(60) });
    const { label } = schema.parse(req.body);
    const branchId = await resolveBranchId(req);

    const { rows: maxRows } = await query(
      `SELECT COALESCE(MAX("order"), 0) AS max_order FROM discount_reasons
       WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)`,
      [branchId]
    );
    const order = Number(maxRows[0].max_order) + 1;

    const { rows } = await query(
      `INSERT INTO discount_reasons (branch_id, label, "order") VALUES ($1,$2,$3) RETURNING *`,
      [branchId, label, order]
    );

    await logAction({
      userId: req.user.id,
      action: "DISCOUNT_REASON_CREATED",
      entity: "DiscountReason",
      entityId: rows[0].id,
      details: { label },
    });

    res.status(201).json({ discountReason: rows[0] });
  })
);

router.patch(
  "/:id",
  requirePermission("settings:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      label: z.string().min(1).max(60).optional(),
      active: z.boolean().optional(),
    });
    const data = schema.parse(req.body);
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "Nada para actualizar." });

    const setParts = [];
    const values = [];
    if (data.label !== undefined) {
      values.push(data.label);
      setParts.push(`label = $${values.length}`);
    }
    if (data.active !== undefined) {
      values.push(data.active);
      setParts.push(`active = $${values.length}`);
    }
    values.push(req.params.id);

    const { rows } = await query(
      `UPDATE discount_reasons SET ${setParts.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: "Motivo no encontrado." });

    await logAction({
      userId: req.user.id,
      action: "DISCOUNT_REASON_UPDATED",
      entity: "DiscountReason",
      entityId: rows[0].id,
      details: data,
    });

    res.json({ discountReason: rows[0] });
  })
);

module.exports = router;
