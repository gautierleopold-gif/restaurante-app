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
    // No se devuelve la contraseña de SMTP en texto plano al frontend.
    const { smtp_pass, ...safe } = branch;
    res.json({ settings: { ...safe, smtp_pass_set: !!smtp_pass } });
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
  invoicePrefix: z.string().min(1).optional(),
  smtpHost: z.string().optional().nullable(),
  smtpPort: z.number().int().optional().nullable(),
  smtpUser: z.string().optional().nullable(),
  smtpPass: z.string().optional().nullable(),
  smtpFrom: z.string().optional().nullable(),
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
      invoicePrefix: "invoice_prefix",
      smtpHost: "smtp_host",
      smtpPort: "smtp_port",
      smtpUser: "smtp_user",
      smtpFrom: "smtp_from",
    };
    // smtpPass se maneja aparte: solo se actualiza si vino un valor no vacío,
    // para no pisarlo con "" cuando el formulario lo deja en blanco a
    // propósito (no se re-muestra la contraseña guardada al frontend).
    const fields = { ...data };
    const smtpPass = fields.smtpPass;
    delete fields.smtpPass;

    const keys = Object.keys(fields).filter((k) => colMap[k]);
    const setParts = keys.map((k, i) => `${colMap[k]} = $${i + 1}`);
    const values = keys.map((k) => fields[k]);
    if (smtpPass) {
      setParts.push(`smtp_pass = $${values.length + 1}`);
      values.push(smtpPass);
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
      details: { ...fields, smtpPass: smtpPass ? "(actualizada)" : undefined },
    });

    const { smtp_pass, ...safe } = rows[0];
    res.json({ settings: { ...safe, smtp_pass_set: !!smtp_pass } });
  })
);

module.exports = router;
