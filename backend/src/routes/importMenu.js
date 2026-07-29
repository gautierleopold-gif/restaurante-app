const express = require("express");
const { z } = require("zod");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");
const { parseWorkbookBase64 } = require("../lib/importParser");
const importStore = require("../lib/importStore");
const {
  PRODUCT_FIELDS,
  VARIANT_FIELDS,
  MODIFIER_FIELDS,
  guessMapping,
  importProductsRows,
  importVariantsRows,
  importModifierGroupsRows,
} = require("../lib/importMenu");

const router = express.Router();
router.use(authenticate);

// Importador de menú desde Fudo u otro sistema: el flujo es (1) subir el
// archivo (.xlsx/.csv) para que el backend lo parsee y proponga un mapeo de
// columnas, (2) el usuario confirma/ajusta ese mapeo por cada sección
// (productos y categorías, variantes, grupos de adicionales) y (3) se
// confirma la importación de cada sección por separado. No se asume un único
// formato de origen: el mapeo de columnas es manual (con sugerencia
// automática), así sirve tanto para Fudo como para cualquier otro sistema que
// exporte a Excel/CSV.

router.post(
  "/parse",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ fileBase64: z.string().min(1), fileName: z.string().optional().default("") });
    const { fileBase64, fileName } = schema.parse(req.body);
    const { sheets } = await parseWorkbookBase64(fileBase64, fileName);

    const importToken = importStore.put({ sheets });

    res.json({
      importToken,
      sheets: sheets.map((s) => ({
        name: s.name,
        headers: s.headers,
        rowCount: s.rowCount,
        preview: s.rows.slice(0, 8),
      })),
      suggestedMappings: {
        productos: sheets.map((s) => guessMapping(s.headers, PRODUCT_FIELDS)),
        variantes: sheets.map((s) => guessMapping(s.headers, VARIANT_FIELDS)),
        adicionales: sheets.map((s) => guessMapping(s.headers, MODIFIER_FIELDS)),
      },
      fieldDefs: {
        productos: PRODUCT_FIELDS,
        variantes: VARIANT_FIELDS,
        adicionales: MODIFIER_FIELDS,
      },
    });
  })
);

function getSheetRows(importToken, sheetIndex) {
  const data = importStore.get(importToken);
  if (!data) {
    throw Object.assign(
      new Error("La sesión de importación expiró (30 min). Volvé a subir el archivo."),
      { status: 410 }
    );
  }
  const sheet = data.sheets[sheetIndex];
  if (!sheet) {
    throw Object.assign(new Error("La hoja seleccionada ya no existe en el archivo."), { status: 400 });
  }
  return sheet.rows;
}

const mappingSchema = z.record(z.string(), z.string().nullable().optional());

router.post(
  "/products/commit",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      importToken: z.string().min(1),
      sheetIndex: z.number().int().min(0),
      mapping: mappingSchema,
    });
    const { importToken, sheetIndex, mapping } = schema.parse(req.body);
    const rows = getSheetRows(importToken, sheetIndex);
    if (!mapping.categoria || !mapping.nombre || !mapping.precio) {
      return res.status(400).json({ error: "Falta mapear Categoría, Nombre y Precio (son obligatorios)." });
    }
    const summary = await importProductsRows(rows, mapping);
    await logAction({
      userId: req.user.id,
      action: "MENU_IMPORTED",
      entity: "Product",
      details: { type: "productos", ...summary, rowErrors: summary.rowErrors.length },
    });
    res.json({ summary });
  })
);

router.post(
  "/variants/commit",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      importToken: z.string().min(1),
      sheetIndex: z.number().int().min(0),
      mapping: mappingSchema,
    });
    const { importToken, sheetIndex, mapping } = schema.parse(req.body);
    const rows = getSheetRows(importToken, sheetIndex);
    if (!mapping.producto || !mapping.variante || !mapping.precio) {
      return res.status(400).json({ error: "Falta mapear Producto, Variante y Precio (son obligatorios)." });
    }
    const summary = await importVariantsRows(rows, mapping);
    await logAction({
      userId: req.user.id,
      action: "MENU_IMPORTED",
      entity: "ProductVariant",
      details: { type: "variantes", ...summary, rowErrors: summary.rowErrors.length },
    });
    res.json({ summary });
  })
);

router.post(
  "/modifiers/commit",
  requirePermission("menu:manage"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      importToken: z.string().min(1),
      sheetIndex: z.number().int().min(0),
      mapping: mappingSchema,
    });
    const { importToken, sheetIndex, mapping } = schema.parse(req.body);
    const rows = getSheetRows(importToken, sheetIndex);
    if (!mapping.grupo || !mapping.opcion) {
      return res.status(400).json({ error: "Falta mapear Grupo y Opción (son obligatorios)." });
    }
    const summary = await importModifierGroupsRows(rows, mapping);
    await logAction({
      userId: req.user.id,
      action: "MENU_IMPORTED",
      entity: "ModifierGroup",
      details: { type: "adicionales", ...summary, rowErrors: summary.rowErrors.length },
    });
    res.json({ summary });
  })
);

module.exports = router;
