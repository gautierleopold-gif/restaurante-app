const express = require("express");
const { z } = require("zod");
const { query, withTransaction } = require("../db/pool");
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

// Editor básico de plantillas de factura: nombre, logo (subido como imagen,
// guardado en base64 en la base de datos -- no en disco, porque el hosting
// gratuito de Render tiene almacenamiento efímero y se perdería en cada
// reinicio/deploy), textos de encabezado/pie, color de acento y un preset de
// estilo (CLASICO/MODERNO/MINIMAL). Puede haber varias plantillas guardadas
// ("varios modelos de ejemplares") y elegir cuál usar al facturar.
router.get(
  "/",
  requirePermission("invoices:manageTemplates"),
  asyncHandler(async (req, res) => {
    const branchId = await resolveBranchId(req);
    const { rows } = await query(
      `SELECT id, branch_id, name, header_text, footer_text, accent_color, layout, is_default, created_at,
              (logo_base64 IS NOT NULL) AS has_logo
       FROM invoice_templates WHERE branch_id = $1 ORDER BY created_at ASC`,
      [branchId]
    );
    res.json({ templates: rows });
  })
);

// Trae una plantilla completa (incluyendo el logo en base64), para poder
// precargar el formulario de edición.
router.get(
  "/:id",
  requirePermission("invoices:manageTemplates"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT * FROM invoice_templates WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Plantilla no encontrada." });
    res.json({ template: rows[0] });
  })
);

const templateSchema = z.object({
  name: z.string().min(1),
  logoBase64: z.string().optional().nullable(),
  headerText: z.string().optional().nullable(),
  footerText: z.string().optional().nullable(),
  accentColor: z.string().min(1).default("#2F5233"),
  layout: z.enum(["CLASICO", "MODERNO", "MINIMAL"]).default("CLASICO"),
  isDefault: z.boolean().default(false),
});

router.post(
  "/",
  requirePermission("invoices:manageTemplates"),
  asyncHandler(async (req, res) => {
    const data = templateSchema.parse(req.body);
    const branchId = await resolveBranchId(req);

    const template = await withTransaction(async (client) => {
      if (data.isDefault) {
        await client.query(`UPDATE invoice_templates SET is_default = false WHERE branch_id = $1`, [branchId]);
      }
      const { rows } = await client.query(
        `INSERT INTO invoice_templates (branch_id, name, logo_base64, header_text, footer_text, accent_color, layout, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [branchId, data.name, data.logoBase64 || null, data.headerText || null, data.footerText || null, data.accentColor, data.layout, data.isDefault]
      );
      return rows[0];
    });

    await logAction({ userId: req.user.id, action: "INVOICE_TEMPLATE_CREATED", entity: "InvoiceTemplate", entityId: template.id });
    res.status(201).json({ template });
  })
);

router.patch(
  "/:id",
  requirePermission("invoices:manageTemplates"),
  asyncHandler(async (req, res) => {
    const data = templateSchema.partial().parse(req.body);
    const branchId = await resolveBranchId(req);

    const template = await withTransaction(async (client) => {
      if (data.isDefault) {
        await client.query(`UPDATE invoice_templates SET is_default = false WHERE branch_id = $1`, [branchId]);
      }
      const colMap = {
        name: "name",
        logoBase64: "logo_base64",
        headerText: "header_text",
        footerText: "footer_text",
        accentColor: "accent_color",
        layout: "layout",
        isDefault: "is_default",
      };
      const keys = Object.keys(data).filter((k) => colMap[k]);
      if (keys.length === 0) return null;
      const setClause = keys.map((k, i) => `${colMap[k]} = $${i + 1}`).join(", ");
      const { rows } = await client.query(
        `UPDATE invoice_templates SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
        [...keys.map((k) => data[k]), req.params.id]
      );
      return rows[0];
    });
    if (!template) return res.status(400).json({ error: "Nada para actualizar." });

    await logAction({ userId: req.user.id, action: "INVOICE_TEMPLATE_UPDATED", entity: "InvoiceTemplate", entityId: req.params.id });
    res.json({ template });
  })
);

router.delete(
  "/:id",
  requirePermission("invoices:manageTemplates"),
  asyncHandler(async (req, res) => {
    await query(`DELETE FROM invoice_templates WHERE id = $1`, [req.params.id]);
    await logAction({ userId: req.user.id, action: "INVOICE_TEMPLATE_DELETED", entity: "InvoiceTemplate", entityId: req.params.id });
    res.status(204).send();
  })
);

module.exports = router;
