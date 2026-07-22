const express = require("express");
const { z } = require("zod");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

// Lista los ítems ya enviados a cocina/barra/etc. que todavía no fueron
// entregados, ordenados por antigüedad (los más viejos primero = más
// urgentes). Se puede filtrar por estación.
router.get(
  "/items",
  requirePermission("kitchen:view"),
  asyncHandler(async (req, res) => {
    const params = [];
    let stationFilter = "";
    if (req.query.stationId) {
      params.push(req.query.stationId);
      stationFilter = `AND oi.station_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT oi.*, p.name AS product_name, pv.name AS variant_name, s.name AS station_name,
              o.code AS order_code, o.type AS order_type, t.name AS table_name,
              o.customer_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN product_variants pv ON pv.id = oi.variant_id
       LEFT JOIN stations s ON s.id = oi.station_id
       LEFT JOIN tables t ON t.id = o.table_id
       WHERE oi.sent_at IS NOT NULL
         AND oi.canceled = false
         AND oi.kitchen_status != 'ENTREGADO'
         AND o.status = 'ABIERTO'
         ${stationFilter}
       ORDER BY oi.sent_at ASC`,
      params
    );

    const itemIds = rows.map((r) => r.id);
    let modifiers = [];
    if (itemIds.length > 0) {
      const { rows: modRows } = await query(
        `SELECT oim.order_item_id, m.name AS modifier_name FROM order_item_modifiers oim
         JOIN modifiers m ON m.id = oim.modifier_id WHERE oim.order_item_id = ANY($1::uuid[])`,
        [itemIds]
      );
      modifiers = modRows;
    }

    const items = rows.map((r) => ({
      ...r,
      modifiers: modifiers.filter((m) => m.order_item_id === r.id).map((m) => m.modifier_name),
    }));

    res.json({ items });
  })
);

router.patch(
  "/items/:id/status",
  requirePermission("kitchen:updateStatus"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ status: z.enum(["PENDIENTE", "EN_PREPARACION", "LISTO", "ENTREGADO"]) });
    const { status } = schema.parse(req.body);

    const timestampCol = status === "LISTO" ? "ready_at" : status === "ENTREGADO" ? "delivered_at" : null;
    const { rows } = await query(
      `UPDATE order_items SET kitchen_status = $1 ${timestampCol ? `, ${timestampCol} = now()` : ""}
       WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Ítem no encontrado." });

    await logAction({
      userId: req.user.id,
      action: "KITCHEN_STATUS_UPDATED",
      entity: "OrderItem",
      entityId: req.params.id,
      details: { status },
    });

    const io = req.app.get("io");
    io.emit("kitchen:updated");
    io.emit("order:item-status-changed", rows[0]);
    res.json({ item: rows[0] });
  })
);

module.exports = router;
