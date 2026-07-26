const express = require("express");
const { z } = require("zod");
const { query, withTransaction } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");
const { applyTax } = require("../lib/tax");

const router = express.Router();
router.use(authenticate);

// "Factura libre": un comprobante que no está ligado a un pedido del POS,
// para cuando hay un problema técnico con el pedido y hay que elegir a mano
// qué poner adentro. Reutiliza la misma numeración correlativa, plantillas y
// pipeline de PDF/mail que las facturas de pedidos (routes/orders.js).
const itemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().default(1),
  unitPrice: z.number().nonnegative(),
});

const createSchema = z.object({
  customerName: z.string().optional().nullable(),
  customerTaxId: z.string().optional().nullable(),
  customerEmail: z.string().email().optional().nullable(),
  templateId: z.string().uuid().optional().nullable(),
  items: z.array(itemSchema).min(1),
});

async function fetchInvoiceWithItems(invoiceId) {
  const { rows: invRows } = await query(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
  const invoice = invRows[0];
  if (!invoice) return null;
  const { rows: items } = await query(
    `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC`,
    [invoiceId]
  );
  return { ...invoice, items };
}

router.get(
  "/",
  requirePermission("invoices:issue"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT i.*, u.name AS issued_by_name FROM invoices i
       LEFT JOIN users u ON u.id = i.issued_by_id
       WHERE i.order_id IS NULL
       ORDER BY i.created_at DESC LIMIT 200`
    );
    res.json({ invoices: rows });
  })
);

router.get(
  "/:id",
  requirePermission("invoices:issue"),
  asyncHandler(async (req, res) => {
    const invoice = await fetchInvoiceWithItems(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Factura no encontrada." });
    res.json({ invoice });
  })
);

router.post(
  "/",
  requirePermission("invoices:issue"),
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);

    const invoice = await withTransaction(async (client) => {
      const branchId = req.user.branch_id;
      let branch;
      if (branchId) {
        const { rows } = await client.query(`SELECT * FROM branches WHERE id = $1 FOR UPDATE`, [branchId]);
        branch = rows[0];
      }
      if (!branch) {
        const { rows } = await client.query(`SELECT * FROM branches ORDER BY created_at ASC LIMIT 1 FOR UPDATE`);
        branch = rows[0];
      }
      if (!branch) {
        throw Object.assign(
          new Error("No hay una sucursal configurada. Creá al menos una desde Administración."),
          { status: 409 }
        );
      }

      const subtotal = data.items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);
      const { total, taxAmount } = applyTax(subtotal, branch.tax_rate, branch.tax_mode);

      const number = `${branch.invoice_prefix || "A"}-${String(branch.next_invoice_number || 1).padStart(8, "0")}`;
      await client.query(`UPDATE branches SET next_invoice_number = next_invoice_number + 1 WHERE id = $1`, [
        branch.id,
      ]);

      let templateId = data.templateId || null;
      if (!templateId) {
        const { rows: defaultTemplate } = await client.query(
          `SELECT id FROM invoice_templates WHERE branch_id = $1 AND is_default = true LIMIT 1`,
          [branch.id]
        );
        templateId = defaultTemplate[0]?.id || null;
      }

      const { rows } = await client.query(
        `INSERT INTO invoices
           (order_id, branch_id, number, customer_name, customer_tax_id, customer_email,
            subtotal, total, issued_by_id, tax_rate, tax_mode, tax_amount, tax_label, template_id)
         VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          branch.id,
          number,
          data.customerName || null,
          data.customerTaxId || null,
          data.customerEmail || null,
          subtotal.toFixed(2),
          total.toFixed(2),
          req.user.id,
          branch.tax_rate || 0,
          branch.tax_mode || "NONE",
          taxAmount.toFixed(2),
          branch.tax_label || "IVA",
          templateId,
        ]
      );
      const invoiceRow = rows[0];

      for (const it of data.items) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES ($1,$2,$3,$4)`,
          [invoiceRow.id, it.description, it.quantity, it.unitPrice]
        );
      }

      return invoiceRow;
    });

    await logAction({
      userId: req.user.id,
      action: "FREE_INVOICE_ISSUED",
      entity: "Invoice",
      entityId: invoice.id,
      details: { number: invoice.number },
    });

    const full = await fetchInvoiceWithItems(invoice.id);
    res.status(201).json({ invoice: full });
  })
);

// Convierte una factura libre (con sus invoice_items) en el "pseudo-pedido"
// que espera buildInvoicePdfBuffer, para reutilizar exactamente el mismo
// renderizado de PDF que las facturas de pedidos del POS.
function invoiceAsPseudoOrder(invoice) {
  return {
    code: null,
    customer_name: invoice.customer_name,
    discount_percent: 0,
    items: invoice.items.map((it) => ({
      product_name: it.description,
      variant_name: null,
      quantity: Number(it.quantity),
      unit_price: it.unit_price,
      modifiers: [],
      canceled: false,
    })),
  };
}

router.get(
  "/:id/pdf",
  requirePermission("invoices:issue"),
  asyncHandler(async (req, res) => {
    const { buildInvoicePdfBuffer } = require("../lib/invoicePdf");
    const invoice = await fetchInvoiceWithItems(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Factura no encontrada." });

    let branch = null;
    if (invoice.branch_id) {
      const { rows } = await query(`SELECT * FROM branches WHERE id = $1`, [invoice.branch_id]);
      branch = rows[0];
    }
    let template = null;
    if (invoice.template_id) {
      const { rows } = await query(`SELECT * FROM invoice_templates WHERE id = $1`, [invoice.template_id]);
      template = rows[0] || null;
    }

    const pdfBuffer = await buildInvoicePdfBuffer({
      branch,
      order: invoiceAsPseudoOrder(invoice),
      invoice,
      template,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="factura-${invoice.number}.pdf"`);
    res.send(pdfBuffer);
  })
);

router.post(
  "/:id/email",
  requirePermission("invoices:issue"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ email: z.string().email().optional() });
    const { email } = schema.parse(req.body || {});

    const invoice = await fetchInvoiceWithItems(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Factura no encontrada." });

    const targetEmail = email || invoice.customer_email;
    if (!targetEmail) {
      return res.status(400).json({ error: "Falta un email de destino para enviar la factura." });
    }

    let branch = null;
    if (invoice.branch_id) {
      const { rows } = await query(`SELECT * FROM branches WHERE id = $1`, [invoice.branch_id]);
      branch = rows[0];
    }
    let template = null;
    if (invoice.template_id) {
      const { rows } = await query(`SELECT * FROM invoice_templates WHERE id = $1`, [invoice.template_id]);
      template = rows[0] || null;
    }

    const { buildInvoicePdfBuffer } = require("../lib/invoicePdf");
    const { sendMailWithAttachment } = require("../lib/email");
    const pdfBuffer = await buildInvoicePdfBuffer({
      branch,
      order: invoiceAsPseudoOrder(invoice),
      invoice,
      template,
    });

    await sendMailWithAttachment({
      branch,
      to: targetEmail,
      subject: `Factura ${invoice.number} - ${branch?.legal_name || branch?.name || "Restaurante"}`,
      text: `Adjuntamos el comprobante ${invoice.number}. ¡Gracias por tu compra!`,
      attachmentFilename: `factura-${invoice.number}.pdf`,
      attachmentBuffer: pdfBuffer,
    });

    await query(`UPDATE invoices SET emailed_at = now(), customer_email = $1 WHERE id = $2`, [
      targetEmail,
      invoice.id,
    ]);

    res.json({ ok: true });
  })
);

module.exports = router;
