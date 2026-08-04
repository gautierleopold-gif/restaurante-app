const express = require("express");
const { z } = require("zod");
const { query, withTransaction } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

// Mismo criterio que el resto de la app (routes/cashClosures.js,
// routes/orders.js): la sucursal propia del usuario o, si no tiene, la
// primera que exista.
async function resolveBranchId(req) {
  if (req.user.branch_id) return req.user.branch_id;
  const { rows } = await query(`SELECT id FROM branches ORDER BY created_at ASC LIMIT 1`);
  return rows[0]?.id || null;
}

async function getBalance(branchId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount), 0) AS balance FROM tip_transactions
     WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)`,
    [branchId]
  );
  return Number(rows[0].balance);
}

// Saldo actual + historial reciente.
router.get(
  "/",
  requirePermission("tips:view"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    const balance = await getBalance(branchId);
    const { rows: transactions } = await query(
      `SELECT t.*, u.name AS created_by_name, o.code AS order_code
       FROM tip_transactions t
       LEFT JOIN users u ON u.id = t.created_by_id
       LEFT JOIN orders o ON o.id = t.order_id
       WHERE t.branch_id = $1 OR ($1 IS NULL AND t.branch_id IS NULL)
       ORDER BY t.created_at DESC
       LIMIT 200`,
      [branchId]
    );
    res.json({ balance, transactions });
  })
);

// Agregar una propina manualmente (no ligada necesariamente a un sobrepago).
router.post(
  "/add",
  requirePermission("tips:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ amount: z.number().positive(), notes: z.string().optional().nullable() });
    const { amount, notes } = schema.parse(req.body);
    const branchId = await resolveBranchId(req);
    const { rows } = await query(
      `INSERT INTO tip_transactions (branch_id, type, amount, notes, created_by_id)
       VALUES ($1,'MANUAL_ADD',$2,$3,$4) RETURNING *`,
      [branchId, amount.toFixed(2), notes || null, req.user.id]
    );
    await logAction({
      userId: req.user.id,
      action: "TIP_ADDED",
      entity: "TipTransaction",
      entityId: rows[0].id,
      details: { amount, notes },
    });
    const balance = await getBalance(branchId);
    res.status(201).json({ transaction: rows[0], balance });
  })
);

// Backoffice: reiniciar/vaciar la cuenta (por ejemplo, cuando se reparte la
// propina acumulada entre el personal). No borra el historial: agrega un
// movimiento negativo que deja el saldo en $0, para que quede registrado
// quién y cuándo lo hizo.
router.post(
  "/reset",
  requirePermission("tips:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ notes: z.string().optional().nullable() });
    const { notes } = schema.parse(req.body || {});
    const branchId = await resolveBranchId(req);

    const result = await withTransaction(async (client) => {
      const { rows: balanceRows } = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS balance FROM tip_transactions
         WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)`,
        [branchId]
      );
      const currentBalance = Number(balanceRows[0].balance);
      if (currentBalance <= 0) {
        throw Object.assign(new Error("La cuenta de propinas ya está en $0."), { status: 409 });
      }
      const { rows } = await client.query(
        `INSERT INTO tip_transactions (branch_id, type, amount, notes, created_by_id)
         VALUES ($1,'RESET',$2,$3,$4) RETURNING *`,
        [branchId, (-currentBalance).toFixed(2), notes || null, req.user.id]
      );
      return { transaction: rows[0], previousBalance: currentBalance };
    });

    await logAction({
      userId: req.user.id,
      action: "TIPS_RESET",
      entity: "TipTransaction",
      entityId: result.transaction.id,
      details: { previousBalance: result.previousBalance, notes },
    });

    res.status(201).json({ transaction: result.transaction, balance: 0 });
  })
);

module.exports = router;
