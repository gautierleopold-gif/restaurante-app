const express = require("express");
const { z } = require("zod");
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

// Modo de cierre configurado en Administración → Parámetros (ver
// routes/settings.js): SIMPLE solo pide cuánto efectivo queda para el turno
// siguiente; ARQUEO además pide contar la caja y calcula la diferencia.
async function resolveCashClosureMode(branchId) {
  const { rows } = await query(`SELECT cash_closure_mode FROM branches WHERE id = $1`, [branchId]);
  return rows[0]?.cash_closure_mode === "ARQUEO" ? "ARQUEO" : "SIMPLE";
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
  // El fondo inicial de este período es lo que se dejó como "efectivo para
  // el cambio" en el cierre anterior (0 si es el primer cierre): así el
  // efectivo se traslada de un turno al siguiente sin que el usuario tenga
  // que volver a ingresarlo a mano.
  const { rows: lastRows } = await query(
    `SELECT period_to, cash_left_for_change FROM cash_closures
     WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)
     ORDER BY period_to DESC LIMIT 1`,
    [branchId]
  );
  const periodFrom = lastRows[0]?.period_to || new Date(0);
  const periodTo = new Date();
  const openingFloat = Number(lastRows[0]?.cash_left_for_change || 0);

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

  // Movimientos manuales de caja (ingresos/egresos que no son una venta) del
  // mismo período: se muestran aparte y se incluyen como neto en el resumen,
  // para que un retiro de efectivo o un aporte de fondo no quede invisible.
  const movementFilter = branchId ? `branch_id = $3` : `branch_id IS NULL`;
  const { rows: movementRows } = await query(
    `SELECT type, SUM(amount) AS total FROM cash_movements
     WHERE created_at > $1 AND created_at <= $2 AND ${movementFilter}
     GROUP BY type`,
    params
  );
  let manualMovementsTotal = 0;
  for (const m of movementRows) {
    manualMovementsTotal += m.type === "INGRESO" ? Number(m.total) : -Number(m.total);
  }

  // "Efectivo esperado en caja" = lo que había al empezar (fondo) + lo que
  // se vendió en efectivo + el neto de los movimientos manuales (que, al no
  // tener medio de pago propio, siempre se asumen en efectivo: ver
  // cash_movements en schema.sql). No incluye ventas con otros medios de
  // pago porque esas nunca entran como billetes a la caja física.
  const cashSales = Number(totalsByMethod.EFECTIVO || 0);
  const expectedCash = openingFloat + cashSales + manualMovementsTotal;
  const cashClosureMode = await resolveCashClosureMode(branchId);

  return {
    periodFrom,
    periodTo,
    orderCount: orderRows.length,
    totalSales,
    totalsByMethod,
    manualMovementsTotal,
    openingFloat,
    cashSales,
    expectedCash,
    cashClosureMode,
  };
}

// Cuerpo aceptado al cerrar la caja. countedCash solo se usa (y se exige) en
// modo ARQUEO; en modo SIMPLE alcanza con cashLeftForChange. Todo lo demás
// tiene un valor por defecto razonable para no bloquear el cierre si el
// usuario no completa cada campo a mano.
const closeSchema = z.object({
  notes: z.string().max(500).optional().nullable(),
  countedCash: z.number().min(0).optional(),
  cashWithdrawn: z.number().min(0).optional(),
  cashLeftForChange: z.number().min(0).optional(),
});

// Cierra la caja: registra el resumen del período transcurrido desde el
// último cierre (o desde el principio, si es el primero) hasta ahora, más la
// tesorería de efectivo según el modo configurado en Parámetros:
// - SIMPLE: no bloquea ni valida nada, solo guarda cuánto efectivo queda en
//   caja para el turno siguiente (por defecto, todo lo esperado).
// - ARQUEO: exige el efectivo contado, calcula la diferencia contra lo
//   esperado, y guarda cuánto se retira y cuánto queda de fondo.
router.post(
  "/",
  requirePermission("cashClosure:manage"),
  asyncHandler(async (req, res) => {
    const body = closeSchema.parse(req.body || {});
    const branchId = await resolveBranchId(req);
    const closure = await withTransaction(async (client) => {
      const summary = await computeSummary(branchId);
      const mode = summary.cashClosureMode;

      if (mode === "ARQUEO" && body.countedCash == null) {
        const err = new Error("Ingresá el efectivo contado para cerrar la caja en modo arqueo.");
        err.status = 400;
        throw err;
      }

      const countedCash = mode === "ARQUEO" ? body.countedCash : null;
      const cashWithdrawn = body.cashWithdrawn ?? 0;
      // Si no se especifica cuánto dejar, por defecto se deja todo el
      // efectivo disponible (lo contado en arqueo, o lo esperado en modo
      // simple) menos lo que se retira, como fondo del turno siguiente.
      const availableCash = mode === "ARQUEO" ? countedCash : summary.expectedCash;
      const cashLeftForChange = body.cashLeftForChange ?? Math.max(0, availableCash - cashWithdrawn);
      const difference = mode === "ARQUEO" ? Number((countedCash - summary.expectedCash).toFixed(2)) : null;

      const { rows } = await client.query(
        `INSERT INTO cash_closures
           (branch_id, closed_by_id, period_from, period_to, order_count, total_sales, totals_by_method, notes, manual_movements_total,
            opening_float, counted_cash, cash_withdrawn, cash_left_for_change, difference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          branchId,
          req.user.id,
          summary.periodFrom,
          summary.periodTo,
          summary.orderCount,
          summary.totalSales.toFixed(2),
          JSON.stringify(summary.totalsByMethod),
          body.notes || null,
          summary.manualMovementsTotal.toFixed(2),
          summary.openingFloat.toFixed(2),
          countedCash != null ? countedCash.toFixed(2) : null,
          cashWithdrawn.toFixed(2),
          cashLeftForChange.toFixed(2),
          difference != null ? difference.toFixed(2) : null,
        ]
      );
      return rows[0];
    });

    await logAction({
      userId: req.user.id,
      action: "CASH_CLOSED",
      entity: "CashClosure",
      entityId: closure.id,
      details: {
        orderCount: closure.order_count,
        totalSales: closure.total_sales,
        countedCash: closure.counted_cash,
        difference: closure.difference,
        cashLeftForChange: closure.cash_left_for_change,
      },
    });

    res.status(201).json({ closure });
  })
);

module.exports = router;
