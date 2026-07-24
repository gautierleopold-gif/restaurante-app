const express = require("express");
const ExcelJS = require("exceljs");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();
router.use(authenticate);

function parseRange(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  // Incluye todo el día "hasta".
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

// Cuenta de resultados (ventas, costo de mercadería vendida y ganancia) en un
// rango de fechas, descargable como planilla Excel con varias hojas.
router.get(
  "/income-statement",
  requirePermission("reports:view"),
  asyncHandler(async (req, res) => {
    const { from, to } = parseRange(req);

    const { rows: orderRows } = await query(
      `SELECT o.id, o.code, o.type, o.subtotal, o.total, o.discount_percent, o.closed_at
       FROM orders o WHERE o.status = 'CERRADO' AND o.closed_at BETWEEN $1 AND $2
       ORDER BY o.closed_at ASC`,
      [from, to]
    );

    const { rows: itemRows } = await query(
      `SELECT oi.product_id, p.name AS product_name, oi.quantity, oi.unit_price,
              COALESCE((SELECT SUM(price) FROM order_item_modifiers WHERE order_item_id = oi.id), 0) AS mod_total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       WHERE o.status = 'CERRADO' AND o.closed_at BETWEEN $1 AND $2 AND oi.canceled = false`,
      [from, to]
    );

    const { rows: paymentRows } = await query(
      `SELECT p.method, SUM(p.amount) AS total
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE o.status = 'CERRADO' AND o.closed_at BETWEEN $1 AND $2
       GROUP BY p.method`,
      [from, to]
    );

    const { rows: cogsRows } = await query(
      `SELECT COALESCE(SUM(sm.quantity * i.cost_per_unit), 0) AS cogs
       FROM stock_movements sm
       JOIN ingredients i ON i.id = sm.ingredient_id
       WHERE sm.type = 'SALIDA' AND sm.reason = 'Venta' AND sm.order_id IN (
         SELECT id FROM orders WHERE status = 'CERRADO' AND closed_at BETWEEN $1 AND $2
       )`,
      [from, to]
    );

    const ventasTotales = orderRows.reduce((s, o) => s + Number(o.total), 0);
    const descuentosTotales = orderRows.reduce((s, o) => s + (Number(o.subtotal) - Number(o.total)), 0);
    const cogs = Number(cogsRows[0]?.cogs || 0);
    const gananciaBruta = ventasTotales - cogs;

    const productAgg = {};
    for (const it of itemRows) {
      const key = it.product_id;
      if (!productAgg[key]) productAgg[key] = { name: it.product_name, qty: 0, revenue: 0 };
      const lineTotal = it.quantity * (Number(it.unit_price) + Number(it.mod_total));
      productAgg[key].qty += it.quantity;
      productAgg[key].revenue += lineTotal;
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Gestión Restaurante";
    workbook.created = new Date();

    const resumen = workbook.addWorksheet("Resumen");
    resumen.columns = [
      { header: "Concepto", key: "concepto", width: 34 },
      { header: "Valor", key: "valor", width: 20 },
    ];
    resumen.addRows([
      { concepto: "Desde", valor: from.toLocaleDateString("es-AR") },
      { concepto: "Hasta", valor: to.toLocaleDateString("es-AR") },
      { concepto: "Pedidos cerrados", valor: orderRows.length },
      { concepto: "Ventas totales", valor: ventasTotales },
      { concepto: "Descuentos otorgados", valor: descuentosTotales },
      { concepto: "Costo de mercadería vendida (insumos)", valor: cogs },
      { concepto: "Ganancia bruta", valor: gananciaBruta },
    ]);
    resumen.getRow(1).font = { bold: true };
    resumen.getColumn("valor").numFmt = "#,##0.00";

    const porProducto = workbook.addWorksheet("Ventas por producto");
    porProducto.columns = [
      { header: "Producto", key: "name", width: 32 },
      { header: "Cantidad vendida", key: "qty", width: 18 },
      { header: "Ingresos", key: "revenue", width: 18 },
    ];
    Object.values(productAgg)
      .sort((a, b) => b.revenue - a.revenue)
      .forEach((p) => porProducto.addRow(p));
    porProducto.getRow(1).font = { bold: true };
    porProducto.getColumn("revenue").numFmt = "#,##0.00";

    const porPago = workbook.addWorksheet("Pagos por medio");
    porPago.columns = [
      { header: "Medio de pago", key: "method", width: 20 },
      { header: "Total cobrado", key: "total", width: 18 },
    ];
    paymentRows.forEach((p) => porPago.addRow({ method: p.method, total: Number(p.total) }));
    porPago.getRow(1).font = { bold: true };
    porPago.getColumn("total").numFmt = "#,##0.00";

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="cuenta-de-resultados.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

module.exports = router;
