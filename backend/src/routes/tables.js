const express = require("express");
const { z } = require("zod");
const { query, withTransaction } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Salones (Rooms)
// ---------------------------------------------------------------------------
router.get(
  "/rooms",
  requirePermission("tables:view"),
  asyncHandler(async (req, res) => {
    const { rows: rooms } = await query(`SELECT * FROM rooms ORDER BY name ASC`);
    const { rows: tables } = await query(
      `SELECT t.*, o.id AS open_order_id, o.code AS open_order_code
       FROM tables t
       LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'ABIERTO'
       ORDER BY t.name ASC`
    );
    const roomsWithTables = rooms.map((r) => ({
      ...r,
      tables: tables.filter((t) => t.room_id === r.id),
    }));
    res.json({ rooms: roomsWithTables });
  })
);

router.post(
  "/rooms",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ name: z.string().min(1) });
    const { name } = schema.parse(req.body);
    const { rows } = await query(`INSERT INTO rooms (name) VALUES ($1) RETURNING *`, [name]);
    res.status(201).json({ room: rows[0] });
  })
);

router.patch(
  "/rooms/:id",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ name: z.string().min(1) });
    const { name } = schema.parse(req.body);
    const { rows } = await query(`UPDATE rooms SET name = $1 WHERE id = $2 RETURNING *`, [name, req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Salón no encontrado." });
    res.json({ room: rows[0] });
  })
);

router.delete(
  "/rooms/:id",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    await query(`DELETE FROM rooms WHERE id = $1`, [req.params.id]);
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// Mesas (Tables)
// ---------------------------------------------------------------------------

// Los nombres de mesa tienen que ser únicos (sin importar mayúsculas/acentos
// de más o menos espacios) para que el personal nunca tenga dos mesas con el
// mismo nombre y se confunda sobre a cuál corresponde un pedido.
async function assertUniqueTableName(name, excludeId) {
  const { rows } = await query(
    `SELECT id FROM tables WHERE lower(trim(name)) = lower(trim($1)) AND id IS DISTINCT FROM $2`,
    [name, excludeId || null]
  );
  if (rows.length > 0) {
    throw Object.assign(new Error(`Ya existe una mesa llamada "${name}". Elegí otro nombre.`), { status: 409 });
  }
}

router.post(
  "/tables",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      roomId: z.string().uuid(),
      name: z.string().min(1),
      capacity: z.number().int().min(1).default(4),
      posX: z.number().int().default(0),
      posY: z.number().int().default(0),
      width: z.number().int().min(40).max(400).default(108),
      height: z.number().int().min(40).max(400).default(88),
      shape: z.enum(["RECT", "CIRCLE"]).default("RECT"),
    });
    const data = schema.parse(req.body);
    await assertUniqueTableName(data.name);
    const { rows } = await query(
      `INSERT INTO tables (room_id, name, capacity, pos_x, pos_y, width, height, shape)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [data.roomId, data.name, data.capacity, data.posX, data.posY, data.width, data.height, data.shape]
    );
    res.status(201).json({ table: rows[0] });
  })
);

router.patch(
  "/tables/:id",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      capacity: z.number().int().min(1).optional(),
      posX: z.number().int().optional(),
      posY: z.number().int().optional(),
      roomId: z.string().uuid().optional(),
      width: z.number().int().min(40).max(400).optional(),
      height: z.number().int().min(40).max(400).optional(),
      shape: z.enum(["RECT", "CIRCLE"]).optional(),
    });
    const fields = schema.parse(req.body);
    if (fields.name) await assertUniqueTableName(fields.name, req.params.id);
    const colMap = {
      name: "name",
      capacity: "capacity",
      posX: "pos_x",
      posY: "pos_y",
      roomId: "room_id",
      width: "width",
      height: "height",
      shape: "shape",
    };
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
    const setClause = keys.map((k, i) => `${colMap[k]} = $${i + 1}`).join(", ");
    const { rows } = await query(
      `UPDATE tables SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => fields[k]), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Mesa no encontrada." });
    const io = req.app.get("io");
    io.emit("tables:changed");
    res.json({ table: rows[0] });
  })
);

router.delete(
  "/tables/:id",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    await query(`DELETE FROM tables WHERE id = $1`, [req.params.id]);
    const io = req.app.get("io");
    io.emit("tables:changed");
    res.status(204).send();
  })
);

// Borrado en grupo: para poder seleccionar varias mesas (como archivos en una
// compu) y borrarlas juntas en vez de una por una.
router.post(
  "/tables/bulk-delete",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ ids: z.array(z.string().uuid()).min(1) });
    const { ids } = schema.parse(req.body);
    const { rows } = await query(`DELETE FROM tables WHERE id = ANY($1::uuid[]) RETURNING id, name`, [ids]);
    await logAction({
      userId: req.user.id,
      action: "TABLES_BULK_DELETED",
      entity: "Table",
      entityId: null,
      details: { count: rows.length, names: rows.map((r) => r.name) },
    });
    const io = req.app.get("io");
    io.emit("tables:changed");
    res.json({ deleted: rows.length });
  })
);

// Marcar una mesa como reservada o liberarla manualmente (sin pedido asociado)
router.post(
  "/tables/:id/status",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ status: z.enum(["LIBRE", "RESERVADA"]) });
    const { status } = schema.parse(req.body);
    const { rows } = await query(`UPDATE tables SET status = $1 WHERE id = $2 RETURNING *`, [
      status,
      req.params.id,
    ]);
    const io = req.app.get("io");
    io.emit("table:updated", rows[0]);
    res.json({ table: rows[0] });
  })
);

// Transferir el pedido abierto de una mesa a otra mesa (debe estar libre)
router.post(
  "/tables/:id/transfer",
  requirePermission("tables:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ targetTableId: z.string().uuid() });
    const { targetTableId } = schema.parse(req.body);

    const result = await withTransaction(async (client) => {
      const { rows: targetRows } = await client.query(`SELECT * FROM tables WHERE id = $1`, [targetTableId]);
      const target = targetRows[0];
      if (!target) throw Object.assign(new Error("La mesa destino no existe."), { status: 404 });
      if (target.status !== "LIBRE") {
        throw Object.assign(new Error("La mesa destino no está libre."), { status: 409 });
      }
      const { rows: orderRows } = await client.query(
        `SELECT * FROM orders WHERE table_id = $1 AND status = 'ABIERTO'`,
        [req.params.id]
      );
      const order = orderRows[0];
      if (!order) throw Object.assign(new Error("La mesa de origen no tiene un pedido abierto."), { status: 404 });

      await client.query(`UPDATE orders SET table_id = $1 WHERE id = $2`, [targetTableId, order.id]);
      await client.query(`UPDATE tables SET status = 'OCUPADA' WHERE id = $1`, [targetTableId]);
      await client.query(`UPDATE tables SET status = 'LIBRE' WHERE id = $1`, [req.params.id]);
      return order;
    });

    await logAction({
      userId: req.user.id,
      action: "TABLE_TRANSFERRED",
      entity: "Order",
      entityId: result.id,
      details: { fromTableId: req.params.id, toTableId: targetTableId },
    });

    const io = req.app.get("io");
    io.emit("tables:changed");
    res.json({ ok: true });
  })
);

module.exports = router;
