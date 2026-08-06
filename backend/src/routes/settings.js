const express = require("express");
const { z } = require("zod");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");

const router = express.Router();
router.use(authenticate);

// En este MVP se asume un negocio con una sucursal principal (o, si tiene
// varias, cada usuario administra la suya). Si el usuario logueado no tiene
// sucursal asignada, se usa la primera que exista.
async function resolveBranch(req) {
  if (req.user.branch_id) {
    const { rows } = await query(`SELECT * FROM branches WHERE id = $1`, [req.user.branch_id]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await query(`SELECT * FROM branches ORDER BY created_at ASC LIMIT 1`);
  return rows[0] || null;
}

router.get(
  "/",
  requirePermission("settings:manage"),
  asyncHandler(async (req, res) => {
    const branch = await resolveBranch(req);
    if (!branch) return res.json({ settings: null });
    // No se devuelven la contraseña de SMTP ni la API key de Resend en
    // texto plano al frontend, solo si están cargadas o no.
    const { smtp_pass, resend_api_key, ...safe } = branch;
    res.json({ settings: { ...safe, smtp_pass_set: !!smtp_pass, resend_api_key_set: !!resend_api_key } });
  })
);

// Datos de la sucursal necesarios para imprimir tickets/comandas (nombre,
// dirección, IVA, etc.): cualquier usuario autenticado puede leerlos (un
// mozo o cajero también necesita imprimir), a diferencia de "/" que expone
// además la config de SMTP y requiere el permiso más restrictivo de
// administración de parámetros.
router.get(
  "/public",
  asyncHandler(async (req, res) => {
    const branch = await resolveBranch(req);
    if (!branch) return res.json({ branch: null });
    res.json({
      branch: {
        name: branch.name,
        legalName: branch.legal_name,
        taxId: branch.tax_id,
        address: branch.address,
        fiscalAddress: branch.fiscal_address,
        phone: branch.phone,
        currency: branch.currency,
        currencySymbol: branch.currency_symbol || "$",
        taxRate: branch.tax_rate != null ? Number(branch.tax_rate) : 0,
        taxMode: branch.tax_mode || "NONE",
        taxLabel: branch.tax_label || "IVA",
        language: branch.language || "es",
        cashClosureMode: branch.cash_closure_mode || "SIMPLE",
      },
    });
  })
);

const settingsSchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional().nullable(),
  legalName: z.string().optional().nullable(),
  taxId: z.string().optional().nullable(),
  fiscalAddress: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  currency: z.string().min(1).optional(),
  currencySymbol: z.string().min(1).max(6).optional(),
  invoicePrefix: z.string().min(1).optional(),
  smtpHost: z.string().optional().nullable(),
  smtpPort: z.number().int().optional().nullable(),
  smtpUser: z.string().optional().nullable(),
  smtpPass: z.string().optional().nullable(),
  smtpFrom: z.string().optional().nullable(),
  resendApiKey: z.string().optional().nullable(),
  taxRate: z.number().min(0).max(100).optional(),
  taxMode: z.enum(["NONE", "INCLUSIVE", "ADDITIVE"]).optional(),
  taxLabel: z.string().min(1).optional(),
  language: z.enum(["es", "fr", "en", "pt", "it"]).optional(),
  cashClosureMode: z.enum(["SIMPLE", "ARQUEO"]).optional(),
});

router.patch(
  "/",
  requirePermission("settings:manage"),
  asyncHandler(async (req, res) => {
    const data = settingsSchema.parse(req.body);
    let branch = await resolveBranch(req);
    if (!branch) {
      const { rows } = await query(`INSERT INTO branches (name) VALUES ($1) RETURNING *`, [
        data.name || "Casa Matriz",
      ]);
      branch = rows[0];
    }

    const colMap = {
      name: "name",
      address: "address",
      legalName: "legal_name",
      taxId: "tax_id",
      fiscalAddress: "fiscal_address",
      phone: "phone",
      currency: "currency",
      currencySymbol: "currency_symbol",
      invoicePrefix: "invoice_prefix",
      smtpHost: "smtp_host",
      smtpPort: "smtp_port",
      smtpUser: "smtp_user",
      smtpFrom: "smtp_from",
      taxRate: "tax_rate",
      taxMode: "tax_mode",
      taxLabel: "tax_label",
      language: "language",
      cashClosureMode: "cash_closure_mode",
    };
    // smtpPass y resendApiKey se manejan aparte: solo se actualizan si vino
    // un valor no vacío, para no pisarlos con "" cuando el formulario los
    // deja en blanco a propósito (no se re-muestran al frontend).
    const fields = { ...data };
    const smtpPass = fields.smtpPass;
    const resendApiKey = fields.resendApiKey;
    delete fields.smtpPass;
    delete fields.resendApiKey;

    const keys = Object.keys(fields).filter((k) => colMap[k]);
    const setParts = keys.map((k, i) => `${colMap[k]} = $${i + 1}`);
    const values = keys.map((k) => fields[k]);
    if (smtpPass) {
      setParts.push(`smtp_pass = $${values.length + 1}`);
      values.push(smtpPass);
    }
    if (resendApiKey) {
      setParts.push(`resend_api_key = $${values.length + 1}`);
      values.push(resendApiKey);
    }
    if (setParts.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
    values.push(branch.id);

    const { rows } = await query(
      `UPDATE branches SET ${setParts.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );

    await logAction({
      userId: req.user.id,
      action: "SETTINGS_UPDATED",
      entity: "Branch",
      entityId: branch.id,
      details: {
        ...fields,
        smtpPass: smtpPass ? "(actualizada)" : undefined,
        resendApiKey: resendApiKey ? "(actualizada)" : undefined,
      },
    });

    const { smtp_pass, resend_api_key, ...safe } = rows[0];
    res.json({ settings: { ...safe, smtp_pass_set: !!smtp_pass, resend_api_key_set: !!resend_api_key } });
  })
);

module.exports = router;
