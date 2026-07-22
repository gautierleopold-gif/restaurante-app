const express = require("express");
const { z } = require("zod");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------
router.get(
  "/categories",
  requirePermission("menu:view"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT * FROM categories ORDER BY "order" ASC, name ASC`);
    res.json({ categories: rows });
  })
);

router.post(
  "/categories",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ name: z.string().min(1), order: z.number().int().optional() });
    const { name, order } = schema.parse(req.body);
    const { rows } = await query(
      `INSERT INTO categories (name, "order") VALUES ($1,$2) RETURNING *`,
      [name, order || 0]
    );
    await logAction({ userId: req.user.id, action: "CATEGORY_CREATED", entity: "Category", entityId: rows[0].id });
    res.status(201).json({ category: rows[0] });
  })
);

router.patch(
  "/categories/:id",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      order: z.number().int().optional(),
      active: z.boolean().optional(),
    });
    const fields = schema.parse(req.body);
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
    const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
    const { rows } = await query(
      `UPDATE categories SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => fields[k]), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Categoría no encontrada." });
    res.json({ category: rows[0] });
  })
);

router.delete(
  "/categories/:id",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    await query(`DELETE FROM categories WHERE id = $1`, [req.params.id]);
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// Estaciones de cocina
// ---------------------------------------------------------------------------
router.get(
  "/stations",
  requirePermission("menu:view"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT * FROM stations ORDER BY name ASC`);
    res.json({ stations: rows });
  })
);

router.post(
  "/stations",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ name: z.string().min(1) });
    const { name } = schema.parse(req.body);
    const { rows } = await query(`INSERT INTO stations (name) VALUES ($1) RETURNING *`, [name]);
    res.status(201).json({ station: rows[0] });
  })
);

router.patch(
  "/stations/:id",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ name: z.string().min(1).optional(), active: z.boolean().optional() });
    const fields = schema.parse(req.body);
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    const { rows } = await query(
      `UPDATE stations SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => fields[k]), req.params.id]
    );
    res.json({ station: rows[0] });
  })
);

// ---------------------------------------------------------------------------
// Grupos de modificadores / modificadores
// ---------------------------------------------------------------------------
router.get(
  "/modifier-groups",
  requirePermission("menu:view"),
  asyncHandler(async (req, res) => {
    const { rows: groups } = await query(`SELECT * FROM modifier_groups ORDER BY name ASC`);
    const { rows: modifiers } = await query(`SELECT * FROM modifiers ORDER BY name ASC`);
    const groupsWithModifiers = groups.map((g) => ({
      ...g,
      modifiers: modifiers.filter((m) => m.group_id === g.id),
    }));
    res.json({ modifierGroups: groupsWithModifiers });
  })
);

router.post(
  "/modifier-groups",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      min: z.number().int().min(0).default(0),
      max: z.number().int().min(0).default(1),
      required: z.boolean().default(false),
      modifiers: z.array(z.object({ name: z.string().min(1), price: z.number().default(0) })).default([]),
    });
    const { name, min, max, required, modifiers } = schema.parse(req.body);
    const { rows } = await query(
      `INSERT INTO modifier_groups (name, min, max, required) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, min, max, required]
    );
    const group = rows[0];
    const createdModifiers = [];
    for (const m of modifiers) {
      const { rows: modRows } = await query(
        `INSERT INTO modifiers (group_id, name, price) VALUES ($1,$2,$3) RETURNING *`,
        [group.id, m.name, m.price]
      );
      createdModifiers.push(modRows[0]);
    }
    res.status(201).json({ modifierGroup: { ...group, modifiers: createdModifiers } });
  })
);

router.post(
  "/modifier-groups/:id/modifiers",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ name: z.string().min(1), price: z.number().default(0) });
    const { name, price } = schema.parse(req.body);
    const { rows } = await query(
      `INSERT INTO modifiers (group_id, name, price) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, name, price]
    );
    res.status(201).json({ modifier: rows[0] });
  })
);

// ---------------------------------------------------------------------------
// Productos (con variantes y grupos de modificadores)
// ---------------------------------------------------------------------------
async function fetchFullProduct(productId) {
  const { rows: productRows } = await query(`SELECT * FROM products WHERE id = $1`, [productId]);
  const product = productRows[0];
  if (!product) return null;
  const { rows: variants } = await query(
    `SELECT * FROM product_variants WHERE product_id = $1 ORDER BY price ASC`,
    [productId]
  );
  const { rows: modifierGroups } = await query(
    `SELECT mg.* FROM modifier_groups mg
     JOIN product_modifier_groups pmg ON pmg.modifier_group_id = mg.id
     WHERE pmg.product_id = $1`,
    [productId]
  );
  for (const g of modifierGroups) {
    const { rows: modifiers } = await query(`SELECT * FROM modifiers WHERE group_id = $1`, [g.id]);
    g.modifiers = modifiers;
  }
  return { ...product, variants, modifierGroups };
}

router.get(
  "/products",
  requirePermission("menu:view"),
  asyncHandler(async (req, res) => {
    const { rows: products } = await query(
      `SELECT p.*, c.name AS category_name, s.name AS station_name
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN stations s ON s.id = p.station_id
       ORDER BY c."order" ASC, p.name ASC`
    );
    const { rows: variants } = await query(`SELECT * FROM product_variants`);
    const { rows: pmg } = await query(`SELECT * FROM product_modifier_groups`);
    const { rows: modifierGroups } = await query(`SELECT * FROM modifier_groups`);
    const { rows: modifiers } = await query(`SELECT * FROM modifiers`);

    const full = products.map((p) => ({
      ...p,
      variants: variants.filter((v) => v.product_id === p.id),
      modifierGroups: pmg
        .filter((r) => r.product_id === p.id)
        .map((r) => {
          const g = modifierGroups.find((mg) => mg.id === r.modifier_group_id);
          return g ? { ...g, modifiers: modifiers.filter((m) => m.group_id === g.id) } : null;
        })
        .filter(Boolean),
    }));

    res.json({ products: full });
  })
);

router.post(
  "/products",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      description: z.string().optional().nullable(),
      categoryId: z.string().uuid(),
      stationId: z.string().uuid().optional().nullable(),
      basePrice: z.number().nonnegative(),
      isComposite: z.boolean().default(false),
      imageUrl: z.string().optional().nullable(),
      variants: z.array(z.object({ name: z.string().min(1), price: z.number().nonnegative() })).default([]),
      modifierGroupIds: z.array(z.string().uuid()).default([]),
    });
    const data = schema.parse(req.body);
    const { rows } = await query(
      `INSERT INTO products (name, description, category_id, station_id, base_price, is_composite, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [data.name, data.description || null, data.categoryId, data.stationId || null, data.basePrice, data.isComposite, data.imageUrl || null]
    );
    const product = rows[0];
    for (const v of data.variants) {
      await query(`INSERT INTO product_variants (product_id, name, price) VALUES ($1,$2,$3)`, [
        product.id,
        v.name,
        v.price,
      ]);
    }
    for (const groupId of data.modifierGroupIds) {
      await query(
        `INSERT INTO product_modifier_groups (product_id, modifier_group_id) VALUES ($1,$2)`,
        [product.id, groupId]
      );
    }
    await logAction({ userId: req.user.id, action: "PRODUCT_CREATED", entity: "Product", entityId: product.id });
    res.status(201).json({ product: await fetchFullProduct(product.id) });
  })
);

router.patch(
  "/products/:id",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      description: z.string().optional().nullable(),
      categoryId: z.string().uuid().optional(),
      stationId: z.string().uuid().optional().nullable(),
      basePrice: z.number().nonnegative().optional(),
      isComposite: z.boolean().optional(),
      active: z.boolean().optional(),
      imageUrl: z.string().optional().nullable(),
    });
    const fields = schema.parse(req.body);
    const colMap = {
      name: "name",
      description: "description",
      categoryId: "category_id",
      stationId: "station_id",
      basePrice: "base_price",
      isComposite: "is_composite",
      active: "active",
      imageUrl: "image_url",
    };
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
    const setClause = keys.map((k, i) => `${colMap[k]} = $${i + 1}`).join(", ");
    const { rows } = await query(
      `UPDATE products SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => fields[k]), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Producto no encontrado." });
    await logAction({ userId: req.user.id, action: "PRODUCT_UPDATED", entity: "Product", entityId: req.params.id, details: fields });
    res.json({ product: await fetchFullProduct(req.params.id) });
  })
);

router.delete(
  "/products/:id",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    // Se prefiere desactivar en vez de borrar para no perder historial de pedidos.
    await query(`UPDATE products SET active = false WHERE id = $1`, [req.params.id]);
    res.status(204).send();
  })
);

router.post(
  "/products/:id/variants",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ name: z.string().min(1), price: z.number().nonnegative() });
    const { name, price } = schema.parse(req.body);
    const { rows } = await query(
      `INSERT INTO product_variants (product_id, name, price) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, name, price]
    );
    res.status(201).json({ variant: rows[0] });
  })
);

router.post(
  "/products/:id/modifier-groups/:groupId",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    await query(
      `INSERT INTO product_modifier_groups (product_id, modifier_group_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [req.params.id, req.params.groupId]
    );
    res.status(201).json({ product: await fetchFullProduct(req.params.id) });
  })
);

module.exports = router;
