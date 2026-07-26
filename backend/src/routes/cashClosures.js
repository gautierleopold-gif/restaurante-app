const express = require("express");
const { query, withTransaction } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

// Resuelve la sucursal "activa" del usuario logueado, con el mismo criterio
// que el resto de la app (routes/settings.js, routes/orders.js): la propia
// si tiene una asignada, o si no la primera que exista.
async function resolveBranchId(req) {
  if (req.user.branch_id) return req.user.branch_id;
  const { rows } = await query(`SELECT id FROM branches ORDER BY created_at ASC LIMIT 1`);
  return rows[0]?.id || null;
}

// Historial de cierres de caja, más reciente primero.
router.get(
  "/",
  requirePermission("cashClosure:manage"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    const { rows } = await query(
      `SELECT c.*, u.name AS closed_by_name
       FROM cash_closures c
       LEFT JOIN users u ON u.id = c.closed_by_id
       WHERE c.branch_id = $1 OR ($1 IS NULL AND c.branch_id IS NULL)
       ORDER BY c.period_to DESC
       LIMIT 100`,
      [branchId]
    );
    res.json({ closures: rows });
  })
);

// Vista previa del resumen "si cerrara la caja ahora", sin registrar nada
// todavía: sirve para mostrarle al usuario los totales antes de confirmar.
router.get(
  "/preview",
  requirePermission("cashClosure:manage"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    const summary = await computeSummary(branchId);
    res.json(summary);
  })
);

async function computeSummary(branchId) {
  const { rows: lastRows } = await query(
    `SELECT period_to FROM cash_closures
     WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)
     ORDER BY period_to DESC LIMIT 1`,
    [branchId]
  );
  const periodFrom = lastRows[0]?.period_to || new Date(0);
  const periodTo = new Date();

  const branchFilter = branchId ? `o.branch_id = $3` : `o.branch_id IS NULL`;
  const params = [periodFrom, periodTo];
  if (branchId) params.push(branchId);

  const { rows: orderRows } = await query(
    `SELECT o.id, o.total FROM orders o
     WHERE o.status = 'CERRADO' AND o.closed_at > $1 AND o.closed_at <= $2 AND ${branchFilter}`,
    params
  );
  const orderIds = orderRows.map((o) => o.id);
  const totalSales = orderRows.reduce((sum, o) => sum + Number(o.total), 0);

  let totalsByMethod = {};
  if (orderIds.length > 0) {
    const { rows: paymentRows } = await query(
      `SELECT method, SUM(amount) AS total FROM payments WHERE order_id = ANY($1::uuid[]) GROUP BY method`,
      [orderIds]
    );
    totalsByMethod = Object.fromEntries(paymentRows.map((p) => [p.method, Number(p.total)]));
  }

  return {
    periodFrom,
    periodTo,
    orderCount: orderRows.length,
    totalSales,
    totalsByMethod,
  };
}

// Cierra la caja: registra el resumen del período transcurrido desde el
// último cierre (o desde el principio, si es el primero) hasta ahora. Es un
// "Resumen simple" (no bloquea ni valida efectivo en caja contra un fondo
// inicial): solo deja un registro histórico de lo vendido en el período.
router.post(
  "/",
  requirePermission("cashClosure:manage"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    const closure = await withTransaction(async (client) => {
      const summary = await computeSummary(branchId);
      const { rows } = await client.query(
        `INSERT INTO cash_closures
           (branch_id, closed_by_id, period_from, period_to, order_count, total_sales, totals_by_method, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          branchId,
          req.user.id,
          summary.periodFrom,
          summary.periodTo,
          summary.orderCount,
          summary.totalSales.toFixed(2),
          JSON.stringify(summary.totalsByMethod),
          req.body?.notes || null,
        ]
      );
      return rows[0];
    });

    await logAction({
      userId: req.user.id,
      action: "CASH_CLOSED",
      entity: "CashClosure",
      entityId: closure.id,
      details: { orderCount: closure.order_count, totalSales: closure.total_sales },
    });

    res.status(201).json({ closure });
  })
);

module.exports = router;
