const express = require("express");
const { z } = require("zod");
const { query, withTransaction } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Insumos (ingredients)
// ---------------------------------------------------------------------------
router.get(
  "/ingredients",
  requirePermission("inventory:view"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT *, (stock < min_stock) AS low_stock FROM ingredients ORDER BY name ASC`
    );
    res.json({ ingredients: rows });
  })
);

const ingredientSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1).default("unidad"),
  stock: z.number().default(0),
  minStock: z.number().default(0),
  costPerUnit: z.number().default(0),
});

router.post(
  "/ingredients",
  requirePermission("inventory:manage"),
  asyncHandler(async (req, res) => {
    const data = ingredientSchema.parse(req.body);
    const { rows } = await query(
      `INSERT INTO ingredients (name, unit, stock, min_stock, cost_per_unit) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [data.name, data.unit, data.stock, data.minStock, data.costPerUnit]
    );
    await logAction({ userId: req.user.id, action: "INGREDIENT_CREATED", entity: "Ingredient", entityId: rows[0].id });
    res.status(201).json({ ingredient: rows[0] });
  })
);

router.patch(
  "/ingredients/:id",
  requirePermission("inventory:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      unit: z.string().min(1).optional(),
      minStock: z.number().optional(),
      costPerUnit: z.number().optional(),
      active: z.boolean().optional(),
    });
    const fields = schema.parse(req.body);
    const colMap = { name: "name", unit: "unit", minStock: "min_stock", costPerUnit: "cost_per_unit", active: "active" };
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
    const setClause = keys.map((k, i) => `${colMap[k]} = $${i + 1}`).join(", ");
    const { rows } = await query(
      `UPDATE ingredients SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => fields[k]), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Insumo no encontrado." });
    res.json({ ingredient: rows[0] });
  })
);

// Movimiento manual de stock: ENTRADA (compra), SALIDA (merma/rotura),
// AJUSTE (corrige el stock a un valor exacto, ej. después de un inventario
// físico).
router.post(
  "/ingredients/:id/movements",
  requirePermission("inventory:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      type: z.enum(["ENTRADA", "SALIDA", "AJUSTE"]),
      quantity: z.number(),
      reason: z.string().optional().nullable(),
    });
    const { type, quantity, reason } = schema.parse(req.body);

    const ingredient = await withTransaction(async (client) => {
      const { rows: current } = await client.query(`SELECT * FROM ingredients WHERE id = $1 FOR UPDATE`, [
        req.params.id,
      ]);
      if (!current[0]) throw Object.assign(new Error("Insumo no encontrado."), { status: 404 });

      let delta;
      if (type === "ENTRADA") delta = quantity;
      else if (type === "SALIDA") delta = -quantity;
      else delta = quantity - Number(current[0].stock); // AJUSTE: quantity es el nuevo valor absoluto

      const { rows: updated } = await client.query(
        `UPDATE ingredients SET stock = stock + $1 WHERE id = $2 RETURNING *`,
        [delta, req.params.id]
      );
      await client.query(
        `INSERT INTO stock_movements (ingredient_id, type, quantity, reason, user_id) VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, type, Math.abs(delta), reason || null, req.user.id]
      );
      return updated[0];
    });

    await logAction({
      userId: req.user.id,
      action: "STOCK_MOVEMENT",
      entity: "Ingredient",
      entityId: req.params.id,
      details: { type, quantity, reason },
    });

    res.json({ ingredient });
  })
);

router.get(
  "/ingredients/:id/movements",
  requirePermission("inventory:view"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT sm.*, u.name AS user_name FROM stock_movements sm
       LEFT JOIN users u ON u.id = sm.user_id
       WHERE sm.ingredient_id = $1 ORDER BY sm.created_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json({ movements: rows });
  })
);

// ---------------------------------------------------------------------------
// Recetas (qué insumos y en qué cantidad consume cada producto)
// ---------------------------------------------------------------------------
router.get(
  "/recipes/:productId",
  requirePermission("inventory:view"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT pi.*, i.name AS ingredient_name, i.unit FROM product_ingredients pi
       JOIN ingredients i ON i.id = pi.ingredient_id
       WHERE pi.product_id = $1 ORDER BY i.name ASC`,
      [req.params.productId]
    );
    res.json({ recipe: rows });
  })
);

router.put(
  "/recipes/:productId",
  requirePermission("inventory:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      items: z.array(z.object({ ingredientId: z.string().uuid(), quantity: z.number().positive() })),
    });
    const { items } = schema.parse(req.body);

    await withTransaction(async (client) => {
      await client.query(`DELETE FROM product_ingredients WHERE product_id = $1`, [req.params.productId]);
      for (const item of items) {
        await client.query(
          `INSERT INTO product_ingredients (product_id, ingredient_id, quantity) VALUES ($1,$2,$3)`,
          [req.params.productId, item.ingredientId, item.quantity]
        );
      }
    });

    await logAction({
      userId: req.user.id,
      action: "RECIPE_UPDATED",
      entity: "Product",
      entityId: req.params.productId,
      details: { items },
    });

    const { rows } = await query(
      `SELECT pi.*, i.name AS ingredient_name, i.unit FROM product_ingredients pi
       JOIN ingredients i ON i.id = pi.ingredient_id
       WHERE pi.product_id = $1 ORDER BY i.name ASC`,
      [req.params.productId]
    );
    res.json({ recipe: rows });
  })
);

module.exports = router;
