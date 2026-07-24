const express = require("express");
const { z } = require("zod");
const { query, withTransaction } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");
const { applyStockDelta } = require("../lib/inventory");

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchFullOrder(idOrClient, orderId) {
  const client = typeof idOrClient === "string" ? null : idOrClient;
  const runner = client || { query };
  const id = client ? orderId : idOrClient;

  const { rows: orderRows } = await runner.query(
    `SELECT o.*, t.name AS table_name, r.name AS room_name, u.name AS waiter_name
     FROM orders o
     LEFT JOIN tables t ON t.id = o.table_id
     LEFT JOIN rooms r ON r.id = t.room_id
     LEFT JOIN users u ON u.id = o.waiter_id
     WHERE o.id = $1`,
    [id]
  );
  const order = orderRows[0];
  if (!order) return null;

  const { rows: items } = await runner.query(
    `SELECT oi.*, p.name AS product_name, pv.name AS variant_name, s.name AS station_name
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     LEFT JOIN product_variants pv ON pv.id = oi.variant_id
     LEFT JOIN stations s ON s.id = oi.station_id
     WHERE oi.order_id = $1
     ORDER BY oi.created_at ASC`,
    [id]
  );
  const itemIds = items.map((i) => i.id);
  let modifiers = [];
  if (itemIds.length > 0) {
    const { rows } = await runner.query(
      `SELECT oim.*, m.name AS modifier_name FROM order_item_modifiers oim
       JOIN modifiers m ON m.id = oim.modifier_id
       WHERE oim.order_item_id = ANY($1::uuid[])`,
      [itemIds]
    );
    modifiers = rows;
  }
  const { rows: payments } = await runner.query(
    `SELECT p.*, u.name AS received_by_name FROM payments p
     LEFT JOIN users u ON u.id = p.received_by_id
     WHERE p.order_id = $1 ORDER BY p.created_at ASC`,
    [id]
  );

  const { rows: invoiceRows } = await runner.query(
    `SELECT * FROM invoices WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [id]
  );

  return {
    ...order,
    items: items.map((it) => ({
      ...it,
      modifiers: modifiers.filter((m) => m.order_item_id === it.id),
    })),
    payments,
    totalPaid: payments.reduce((sum, p) => sum + Number(p.amount), 0),
    invoice: invoiceRows[0] || null,
  };
}

async function recalcOrderTotals(client, orderId) {
  const { rows: items } = await client.query(
    `SELECT oi.quantity, oi.unit_price,
       COALESCE((SELECT SUM(price) FROM order_item_modifiers WHERE order_item_id = oi.id), 0) AS mod_total
     FROM order_items oi WHERE oi.order_id = $1 AND oi.canceled = false`,
    [orderId]
  );
  const subtotal = items.reduce(
    (sum, it) => sum + Number(it.quantity) * (Number(it.unit_price) + Number(it.mod_total)),
    0
  );
  const { rows: orderRows } = await client.query(`SELECT discount_percent FROM orders WHERE id = $1`, [orderId]);
  const discountPercent = Number(orderRows[0]?.discount_percent || 0);
  const total = subtotal * (1 - discountPercent / 100);
  await client.query(`UPDATE orders SET subtotal = $1, total = $2 WHERE id = $3`, [
    subtotal.toFixed(2),
    total.toFixed(2),
    orderId,
  ]);
}

function emitOrderUpdate(req, order) {
  const io = req.app.get("io");
  io.emit("order:updated", order);
  io.emit("kitchen:updated");
  io.emit("tables:changed");
}

// ---------------------------------------------------------------------------
// Listado y detalle
// ---------------------------------------------------------------------------
router.get(
  "/",
  requirePermission("orders:view"),
  asyncHandler(async (req, res) => {
    const status = req.query.status; // ABIERTO | CERRADO | CANCELADO
    const params = [];
    let where = "";
    if (status) {
      params.push(status);
      where = `WHERE o.status = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT o.*, t.name AS table_name, u.name AS waiter_name
       FROM orders o
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN users u ON u.id = o.waiter_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ orders: rows });
  })
);

router.get(
  "/:id",
  requirePermission("orders:view"),
  asyncHandler(async (req, res) => {
    const order = await fetchFullOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    res.json({ order });
  })
);

// ---------------------------------------------------------------------------
// Crear pedido
// ---------------------------------------------------------------------------
const createOrderSchema = z.object({
  type: z.enum(["SALON", "RETIRO", "DELIVERY"]),
  tableId: z.string().uuid().optional().nullable(),
  customerName: z.string().optional().nullable(),
  customerPhone: z.string().optional().nullable(),
  customerAddress: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post(
  "/",
  requirePermission("orders:create"),
  asyncHandler(async (req, res) => {
    const data = createOrderSchema.parse(req.body);

    if (data.type === "SALON" && !data.tableId) {
      return res.status(400).json({ error: "Los pedidos de salón requieren una mesa." });
    }
    if (data.type === "DELIVERY" && !data.customerAddress) {
      return res.status(400).json({ error: "Los pedidos de delivery requieren una dirección." });
    }

    const order = await withTransaction(async (client) => {
      if (data.type === "SALON") {
        const { rows: existing } = await client.query(
          `SELECT id FROM orders WHERE table_id = $1 AND status = 'ABIERTO'`,
          [data.tableId]
        );
        if (existing.length > 0) {
          throw Object.assign(
            new Error("Esta mesa ya tiene un pedido abierto. Agregá los productos a ese pedido."),
            { status: 409 }
          );
        }
      }

      const { rows } = await client.query(
        `INSERT INTO orders (type, table_id, waiter_id, branch_id, customer_name, customer_phone, customer_address, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          data.type,
          data.tableId || null,
          req.user.id,
          req.user.branch_id || null,
          data.customerName || null,
          data.customerPhone || null,
          data.customerAddress || null,
          data.notes || null,
        ]
      );
      if (data.type === "SALON") {
        await client.query(`UPDATE tables SET status = 'OCUPADA' WHERE id = $1`, [data.tableId]);
      }
      return rows[0];
    });

    await logAction({ userId: req.user.id, action: "ORDER_CREATED", entity: "Order", entityId: order.id, details: data });

    const fullOrder = await fetchFullOrder(order.id);
    emitOrderUpdate(req, fullOrder);
    res.status(201).json({ order: fullOrder });
  })
);

// ---------------------------------------------------------------------------
// Ítems del pedido
// ---------------------------------------------------------------------------
const addItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional().nullable(),
  quantity: z.number().int().min(1).default(1),
  notes: z.string().optional().nullable(),
  modifierIds: z.array(z.string().uuid()).default([]),
});

router.post(
  "/:id/items",
  requirePermission("orders:update"),
  asyncHandler(async (req, res) => {
    const data = addItemSchema.parse(req.body);

    await withTransaction(async (client) => {
      const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
      const order = orderRows[0];
      if (!order) throw Object.assign(new Error("Pedido no encontrado."), { status: 404 });
      if (order.status !== "ABIERTO") {
        throw Object.assign(new Error("El pedido ya está cerrado o cancelado."), { status: 409 });
      }

      const { rows: productRows } = await client.query(`SELECT * FROM products WHERE id = $1`, [data.productId]);
      const product = productRows[0];
      if (!product || !product.active) {
        throw Object.assign(new Error("El producto no existe o no está disponible."), { status: 404 });
      }

      let unitPrice = Number(product.base_price);
      if (data.variantId) {
        const { rows: variantRows } = await client.query(
          `SELECT * FROM product_variants WHERE id = $1 AND product_id = $2`,
          [data.variantId, data.productId]
        );
        if (!variantRows[0]) throw Object.assign(new Error("Variante inválida."), { status: 400 });
        unitPrice = Number(variantRows[0].price);
      }

      const { rows: itemRows } = await client.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, station_id, quantity, unit_price, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [order.id, data.productId, data.variantId || null, product.station_id, data.quantity, unitPrice, data.notes || null]
      );
      const item = itemRows[0];

      for (const modifierId of data.modifierIds) {
        const { rows: modRows } = await client.query(`SELECT * FROM modifiers WHERE id = $1`, [modifierId]);
        if (modRows[0]) {
          await client.query(
            `INSERT INTO order_item_modifiers (order_item_id, modifier_id, price) VALUES ($1,$2,$3)`,
            [item.id, modifierId, modRows[0].price]
          );
        }
      }

      // Si el producto tiene una receta cargada (Inventario), descuenta el
      // stock de los insumos correspondientes automáticamente.
      await applyStockDelta(client, {
        productId: data.productId,
        deltaQuantity: data.quantity,
        orderId: order.id,
        userId: req.user.id,
        reason: "Venta",
      });

      await recalcOrderTotals(client, order.id);
    });

    await logAction({ userId: req.user.id, action: "ORDER_ITEM_ADDED", entity: "Order", entityId: req.params.id, details: data });

    const fullOrder = await fetchFullOrder(req.params.id);
    emitOrderUpdate(req, fullOrder);
    res.status(201).json({ order: fullOrder });
  })
);

router.patch(
  "/:id/items/:itemId",
  requirePermission("orders:update"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      quantity: z.number().int().min(1).optional(),
      notes: z.string().optional().nullable(),
    });
    const fields = schema.parse(req.body);
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: "Nada para actualizar." });

    await withTransaction(async (client) => {
      let previousQuantity = null;
      let productId = null;
      if (fields.quantity !== undefined) {
        const { rows: existing } = await client.query(
          `SELECT quantity, product_id FROM order_items WHERE id = $1 AND order_id = $2`,
          [req.params.itemId, req.params.id]
        );
        if (existing[0]) {
          previousQuantity = existing[0].quantity;
          productId = existing[0].product_id;
        }
      }

      const colMap = { quantity: "quantity", notes: "notes" };
      const setClause = keys.map((k, i) => `${colMap[k]} = $${i + 1}`).join(", ");
      await client.query(
        `UPDATE order_items SET ${setClause} WHERE id = $${keys.length + 1} AND order_id = $${keys.length + 2}`,
        [...keys.map((k) => fields[k]), req.params.itemId, req.params.id]
      );

      if (fields.quantity !== undefined && previousQuantity !== null) {
        await applyStockDelta(client, {
          productId,
          deltaQuantity: fields.quantity - previousQuantity,
          orderId: req.params.id,
          userId: req.user.id,
          reason: "Ajuste de cantidad en pedido",
        });
      }

      await recalcOrderTotals(client, req.params.id);
    });

    const fullOrder = await fetchFullOrder(req.params.id);
    emitOrderUpdate(req, fullOrder);
    res.json({ order: fullOrder });
  })
);

// Anular/cancelar un ítem del pedido (requiere permiso elevado)
router.post(
  "/:id/items/:itemId/cancel",
  requirePermission("orders:cancelItem"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ reason: z.string().min(1) });
    const { reason } = schema.parse(req.body);

    await withTransaction(async (client) => {
      const { rows: updatedRows } = await client.query(
        `UPDATE order_items SET canceled = true, canceled_by_id = $1, cancel_reason = $2
         WHERE id = $3 AND order_id = $4 AND canceled = false
         RETURNING product_id, quantity`,
        [req.user.id, reason, req.params.itemId, req.params.id]
      );
      // Si realmente se anuló ahora (no estaba ya anulado), repone el stock
      // de los insumos que se habían descontado al vender este ítem.
      if (updatedRows[0]) {
        await applyStockDelta(client, {
          productId: updatedRows[0].product_id,
          deltaQuantity: -updatedRows[0].quantity,
          orderId: req.params.id,
          userId: req.user.id,
          reason: "Anulación de ítem",
        });
      }
      await recalcOrderTotals(client, req.params.id);
    });

    await logAction({
      userId: req.user.id,
      action: "ORDER_ITEM_CANCELED",
      entity: "OrderItem",
      entityId: req.params.itemId,
      details: { reason },
    });

    const fullOrder = await fetchFullOrder(req.params.id);
    emitOrderUpdate(req, fullOrder);
    res.json({ order: fullOrder });
  })
);

// Enviar a cocina/barra/postres los ítems pendientes de envío
router.post(
  "/:id/send-to-kitchen",
  requirePermission("orders:update"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE order_items SET sent_at = now()
       WHERE order_id = $1 AND sent_at IS NULL AND canceled = false RETURNING id`,
      [req.params.id]
    );

    await logAction({
      userId: req.user.id,
      action: "ORDER_SENT_TO_KITCHEN",
      entity: "Order",
      entityId: req.params.id,
      details: { itemCount: rows.length },
    });

    const fullOrder = await fetchFullOrder(req.params.id);
    emitOrderUpdate(req, fullOrder);
    res.json({ order: fullOrder });
  })
);

// ---------------------------------------------------------------------------
// Descuentos
// ---------------------------------------------------------------------------
router.post(
  "/:id/discount",
  requirePermission("orders:discount"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ percent: z.number().min(0).max(100), reason: z.string().optional().nullable() });
    const { percent, reason } = schema.parse(req.body);

    await withTransaction(async (client) => {
      await client.query(`UPDATE orders SET discount_percent = $1, discount_reason = $2 WHERE id = $3`, [
        percent,
        reason || null,
        req.params.id,
      ]);
      await recalcOrderTotals(client, req.params.id);
    });

    await logAction({
      userId: req.user.id,
      action: "ORDER_DISCOUNT_APPLIED",
      entity: "Order",
      entityId: req.params.id,
      details: { percent, reason },
    });

    const fullOrder = await fetchFullOrder(req.params.id);
    emitOrderUpdate(req, fullOrder);
    res.json({ order: fullOrder });
  })
);

// ---------------------------------------------------------------------------
// Pagos (permite dividir la cuenta registrando varios pagos)
// ---------------------------------------------------------------------------
router.post(
  "/:id/payments",
  requirePermission("payments:register"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      method: z.enum(["EFECTIVO", "TARJETA", "TRANSFERENCIA", "DIGITAL", "OTRO"]),
      amount: z.number().positive(),
    });
    const { method, amount } = schema.parse(req.body);

    const { rows } = await query(
      `INSERT INTO payments (order_id, method, amount, received_by_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, method, amount, req.user.id]
    );

    await logAction({
      userId: req.user.id,
      action: "PAYMENT_REGISTERED",
      entity: "Order",
      entityId: req.params.id,
      details: { method, amount },
    });

    const fullOrder = await fetchFullOrder(req.params.id);
    emitOrderUpdate(req, fullOrder);
    res.status(201).json({ payment: rows[0], order: fullOrder });
  })
);

// ---------------------------------------------------------------------------
// Cerrar / cancelar pedido
// ---------------------------------------------------------------------------
router.post(
  "/:id/close",
  requirePermission("orders:close"),
  asyncHandler(async (req, res) => {
    const order = await withTransaction(async (client) => {
      const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
      const order = orderRows[0];
      if (!order) throw Object.assign(new Error("Pedido no encontrado."), { status: 404 });
      if (order.status !== "ABIERTO") {
        throw Object.assign(new Error("El pedido ya está cerrado o cancelado."), { status: 409 });
      }

      const { rows: paymentRows } = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS total_paid FROM payments WHERE order_id = $1`,
        [req.params.id]
      );
      const totalPaid = Number(paymentRows[0].total_paid);
      if (totalPaid + 0.01 < Number(order.total)) {
        throw Object.assign(
          new Error(`Falta registrar el pago. Total: ${order.total}, pagado: ${totalPaid.toFixed(2)}.`),
          { status: 409 }
        );
      }

      const { rows: updated } = await client.query(
        `UPDATE orders SET status = 'CERRADO', closed_at = now() WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      if (order.table_id) {
        await client.query(`UPDATE tables SET status = 'LIBRE' WHERE id = $1`, [order.table_id]);
      }
      return updated[0];
    });

    await logAction({ userId: req.user.id, action: "ORDER_CLOSED", entity: "Order", entityId: order.id });

    const fullOrder = await fetchFullOrder(order.id);
    emitOrderUpdate(req, fullOrder);
    res.json({ order: fullOrder });
  })
);

router.post(
  "/:id/cancel",
  requirePermission("orders:cancelItem"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ reason: z.string().min(1) });
    const { reason } = schema.parse(req.body);

    const order = await withTransaction(async (client) => {
      const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
      const order = orderRows[0];
      if (!order) throw Object.assign(new Error("Pedido no encontrado."), { status: 404 });

      const { rows: updated } = await client.query(
        `UPDATE orders SET status = 'CANCELADO', closed_at = now(), notes = COALESCE(notes || ' | ', '') || $1 WHERE id = $2 RETURNING *`,
        [`Cancelado: ${reason}`, req.params.id]
      );
      if (order.table_id) {
        await client.query(`UPDATE tables SET status = 'LIBRE' WHERE id = $1`, [order.table_id]);
      }
      return updated[0];
    });

    await logAction({
      userId: req.user.id,
      action: "ORDER_CANCELED",
      entity: "Order",
      entityId: order.id,
      details: { reason },
    });

    const fullOrder = await fetchFullOrder(order.id);
    emitOrderUpdate(req, fullOrder);
    res.json({ order: fullOrder });
  })
);

// ---------------------------------------------------------------------------
// Marcar mesa como "pendiente de pago" (mozo pide la cuenta)
// ---------------------------------------------------------------------------
router.post(
  "/:id/request-bill",
  requirePermission("orders:update"),
  asyncHandler(async (req, res) => {
    const { rows: orderRows } = await query(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
    const order = orderRows[0];
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    if (order.table_id) {
      await query(`UPDATE tables SET status = 'PENDIENTE_PAGO' WHERE id = $1`, [order.table_id]);
    }
    const io = req.app.get("io");
    io.emit("tables:changed");
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Facturación
// ---------------------------------------------------------------------------
const issueInvoiceSchema = z.object({
  customerName: z.string().optional().nullable(),
  customerTaxId: z.string().optional().nullable(),
  customerEmail: z.string().email().optional().nullable(),
});

// Emite un comprobante/factura para un pedido ya cerrado. El número se arma
// con el prefijo y el correlativo configurados en Administración →
// Parámetros de la sucursal, y ese correlativo se incrementa automáticamente.
router.post(
  "/:id/invoice",
  requirePermission("invoices:issue"),
  asyncHandler(async (req, res) => {
    const data = issueInvoiceSchema.parse(req.body || {});

    const invoice = await withTransaction(async (client) => {
      const { rows: orderRows } = await client.query(`SELECT * FROM orders WHERE id = $1`, [req.params.id]);
      const order = orderRows[0];
      if (!order) throw Object.assign(new Error("Pedido no encontrado."), { status: 404 });
      if (order.status !== "CERRADO") {
        throw Object.assign(new Error("Solo se puede facturar un pedido ya cerrado/cobrado."), { status: 409 });
      }

      const { rows: existingInvoice } = await client.query(`SELECT * FROM invoices WHERE order_id = $1`, [
        req.params.id,
      ]);
      if (existingInvoice[0]) return existingInvoice[0];

      const branchId = order.branch_id || req.user.branch_id;
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

      const number = `${branch.invoice_prefix || "A"}-${String(branch.next_invoice_number || 1).padStart(8, "0")}`;
      await client.query(`UPDATE branches SET next_invoice_number = next_invoice_number + 1 WHERE id = $1`, [
        branch.id,
      ]);

      const { rows } = await client.query(
        `INSERT INTO invoices (order_id, branch_id, number, customer_name, customer_tax_id, customer_email, subtotal, total, issued_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          order.id,
          branch.id,
          number,
          data.customerName || order.customer_name || null,
          data.customerTaxId || null,
          data.customerEmail || null,
          order.subtotal,
          order.total,
          req.user.id,
        ]
      );
      return rows[0];
    });

    await logAction({
      userId: req.user.id,
      action: "INVOICE_ISSUED",
      entity: "Order",
      entityId: req.params.id,
      details: { number: invoice.number },
    });

    const fullOrder = await fetchFullOrder(req.params.id);
    res.status(201).json({ invoice, order: fullOrder });
  })
);

router.get(
  "/:id/invoice/pdf",
  requirePermission("invoices:issue"),
  asyncHandler(async (req, res) => {
    const { buildInvoicePdfBuffer } = require("../lib/invoicePdf");
    const order = await fetchFullOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    if (!order.invoice) return res.status(404).json({ error: "Este pedido todavía no tiene una factura emitida." });

    let branch = null;
    if (order.branch_id) {
      const { rows } = await query(`SELECT * FROM branches WHERE id = $1`, [order.branch_id]);
      branch = rows[0];
    }

    const pdfBuffer = await buildInvoicePdfBuffer({ branch, order, invoice: order.invoice });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="factura-${order.invoice.number}.pdf"`);
    res.send(pdfBuffer);
  })
);

router.post(
  "/:id/invoice/email",
  requirePermission("invoices:issue"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ email: z.string().email().optional() });
    const { email } = schema.parse(req.body || {});

    const order = await fetchFullOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    if (!order.invoice) return res.status(404).json({ error: "Este pedido todavía no tiene una factura emitida." });

    const targetEmail = email || order.invoice.customer_email;
    if (!targetEmail) {
      return res.status(400).json({ error: "Falta un email de destino para enviar la factura." });
    }

    let branch = null;
    if (order.branch_id) {
      const { rows } = await query(`SELECT * FROM branches WHERE id = $1`, [order.branch_id]);
      branch = rows[0];
    }
    if (!branch || !branch.smtp_host || !branch.smtp_user || !branch.smtp_pass) {
      return res.status(400).json({
        error:
          "El envío de facturas por mail no está configurado. Completá los datos de SMTP en Administración → Parámetros.",
      });
    }

    const nodemailer = require("nodemailer");
    const { buildInvoicePdfBuffer } = require("../lib/invoicePdf");
    const pdfBuffer = await buildInvoicePdfBuffer({ branch, order, invoice: order.invoice });

    const transporter = nodemailer.createTransport({
      host: branch.smtp_host,
      port: branch.smtp_port || 587,
      secure: Number(branch.smtp_port) === 465,
      auth: { user: branch.smtp_user, pass: branch.smtp_pass },
    });

    await transporter.sendMail({
      from: branch.smtp_from || branch.smtp_user,
      to: targetEmail,
      subject: `Factura ${order.invoice.number} - ${branch.legal_name || branch.name}`,
      text: `Adjuntamos el comprobante ${order.invoice.number} correspondiente a tu pedido #${order.code}. ¡Gracias por tu compra!`,
      attachments: [{ filename: `factura-${order.invoice.number}.pdf`, content: pdfBuffer }],
    });

    await query(`UPDATE invoices SET emailed_at = now(), customer_email = $1 WHERE id = $2`, [
      targetEmail,
      order.invoice.id,
    ]);

    await logAction({
      userId: req.user.id,
      action: "INVOICE_EMAILED",
      entity: "Order",
      entityId: req.params.id,
      details: { email: targetEmail },
    });

    res.json({ ok: true });
  })
);

module.exports = router;
