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

// Historial reciente de movimientos manuales (ingresos/egresos que no son
// una venta), más nuevo primero.
router.get(
  "/",
  requirePermission("cashClosure:manage"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    const { rows } = await query(
      `SELECT cm.*, u.name AS created_by_name
       FROM cash_movements cm
       LEFT JOIN users u ON u.id = cm.created_by_id
       WHERE cm.branch_id = $1 OR ($1 IS NULL AND cm.branch_id IS NULL)
       ORDER BY cm.created_at DESC
       LIMIT 200`,
      [branchId]
    );
    res.json({ movements: rows });
  })
);

// Registra un ingreso o egreso manual (ej. un retiro de efectivo para comprar
// algo en el momento, o un aporte de fondo). No modifica ningún pedido ni
// venta: es un movimiento aparte que se suma al resumen de caja del período.
router.post(
  "/",
  requirePermission("cashClosure:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      type: z.enum(["INGRESO", "EGRESO"]),
      amount: z.number().positive(),
      reason: z.string().max(300).optional().nullable(),
    });
    const { type, amount, reason } = schema.parse(req.body);
    const branchId = await resolveBranchId(req);

    const { rows } = await query(
      `INSERT INTO cash_movements (branch_id, type, amount, reason, created_by_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [branchId, type, amount.toFixed(2), reason || null, req.user.id]
    );

    await logAction({
      userId: req.user.id,
      action: "CASH_MOVEMENT_ADDED",
      entity: "CashMovement",
      entityId: rows[0].id,
      details: { type, amount, reason },
    });

    res.status(201).json({ movement: { ...rows[0], created_by_name: req.user.name } });
  })
);

module.exports = router;
