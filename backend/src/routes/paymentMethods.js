const express = require("express");
const { z } = require("zod");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

// Mismo criterio que el resto de la app (routes/settings.js, routes/tips.js):
// la sucursal propia del usuario o, si no tiene, la primera que exista.
async function resolveBranchId(req) {
  if (req.user.branch_id) return req.user.branch_id;
  const { rows } = await query(`SELECT id FROM branches ORDER BY created_at ASC LIMIT 1`);
  return rows[0]?.id || null;
}

// El esquema siembra los 5 medios de pago "de siempre" para cada sucursal
// que ya exista al momento de aplicar la migración (ver schema.sql), pero
// una sucursal creada después (instalación nueva, db:reset) puede llegar
// acá sin ninguna fila todavía. Esta func se asegura de que siempre haya al
// menos el set por defecto, sin duplicar si ya existen.
async function ensureDefaultsSeeded(branchId) {
  const { rows } = await query(
    `SELECT 1 FROM payment_methods WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL) LIMIT 1`,
    [branchId]
  );
  if (rows.length > 0) return;
  const defaults = [
    ["EFECTIVO", "Efectivo", 1],
    ["TARJETA", "Tarjeta", 2],
    ["TRANSFERENCIA", "Transferencia", 3],
    ["DIGITAL", "Pago digital", 4],
    ["OTRO", "Otro", 5],
  ];
  for (const [code, label, order] of defaults) {
    await query(
      `INSERT INTO payment_methods (branch_id, code, label, "order") VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [branchId, code, label, order]
    );
  }
}

// Genera un código estable a partir de la etiqueta escrita por el usuario
// (mayúsculas, sin acentos, espacios -> guion bajo), para guardar en
// payments.method. No se vuelve a cambiar después de creado.
function codeFromLabel(label) {
  return (
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "OTRO"
  );
}

// Lista activa, en el orden configurado: la usa el POS para armar el
// desplegable de "Medio de pago" al registrar un cobro.
router.get(
  "/",
  requirePermission("payments:register"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    await ensureDefaultsSeeded(branchId);
    const { rows } = await query(
      `SELECT * FROM payment_methods
       WHERE (branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)) AND active = TRUE
       ORDER BY "order" ASC, label ASC`,
      [branchId]
    );
    res.json({ paymentMethods: rows });
  })
);

// Lista completa (incluye inactivos): pantalla de Administración → Parámetros.
router.get(
  "/all",
  requirePermission("settings:manage"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    await ensureDefaultsSeeded(branchId);
    const { rows } = await query(
      `SELECT * FROM payment_methods
       WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)
       ORDER BY "order" ASC, label ASC`,
      [branchId]
    );
    res.json({ paymentMethods: rows });
  })
);

router.post(
  "/",
  requirePermission("settings:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ label: z.string().min(1).max(60) });
    const { label } = schema.parse(req.body);
    const branchId = await resolveBranchId(req);

    const baseCode = codeFromLabel(label);
    let code = baseCode;
    let suffix = 2;
    // Evita choques de código si ya existe uno igual (ej. dos motivos que
    // normalizan al mismo texto).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { rows: existing } = await query(
        `SELECT 1 FROM payment_methods WHERE (branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)) AND code = $2`,
        [branchId, code]
      );
      if (existing.length === 0) break;
      code = `${baseCode}_${suffix++}`;
    }

    const { rows: maxRows } = await query(
      `SELECT COALESCE(MAX("order"), 0) AS max_order FROM payment_methods
       WHERE branch_id = $1 OR ($1 IS NULL AND branch_id IS NULL)`,
      [branchId]
    );
    const order = Number(maxRows[0].max_order) + 1;

    const { rows } = await query(
      `INSERT INTO payment_methods (branch_id, code, label, "order") VALUES ($1,$2,$3,$4) RETURNING *`,
      [branchId, code, label, order]
    );

    await logAction({
      userId: req.user.id,
      action: "PAYMENT_METHOD_CREATED",
      entity: "PaymentMethod",
      entityId: rows[0].id,
      details: { code, label },
    });

    res.status(201).json({ paymentMethod: rows[0] });
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
      `UPDATE payment_methods SET ${setParts.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: "Medio de pago no encontrado." });

    await logAction({
      userId: req.user.id,
      action: "PAYMENT_METHOD_UPDATED",
      entity: "PaymentMethod",
      entityId: rows[0].id,
      details: data,
    });

    res.json({ paymentMethod: rows[0] });
  })
);

module.exports = router;
