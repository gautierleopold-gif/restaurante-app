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

    // Costo de mercadería vendida: se computa como el neto de todos los
    // movimientos de stock ligados a pedidos cerrados en el rango (SALIDA
    // suma consumo, ENTRADA resta), en vez de filtrar por el texto exacto de
    // "reason". Esto evita dos errores: (1) no contar el consumo generado al
    // aumentar la cantidad de un ítem ya cargado ("Ajuste de cantidad en
    // pedido"), y (2) no descontar el stock que se repone al anular un ítem
    // ("Anulación de ítem"), que antes se sumaba de más al costo.
    const { rows: cogsRows } = await query(
      `SELECT COALESCE(SUM(
         CASE WHEN sm.type = 'SALIDA' THEN sm.quantity ELSE -sm.quantity END
         * i.cost_per_unit
       ), 0) AS cogs
       FROM stock_movements sm
       JOIN ingredients i ON i.id = sm.ingredient_id
       WHERE sm.order_id IN (
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

    // --- Estilos compartidos --------------------------------------------
    const BRAND_ARGB = "FF2F5233"; // verde oscuro
    const STRIPE_ARGB = "FFF3F6F1";
    const THIN = { style: "thin", color: { argb: "FFD9D9D9" } };
    const CELL_BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

    // Agrega una fila de título (fusionada) + una subtítulo con el rango de
    // fechas, y devuelve el número de fila donde queda el encabezado real de
    // la tabla (para poder aplicarle estilos, autofiltro y freeze panes).
    function addTitleBlock(sheet, title) {
      const lastCol = sheet.columns.length;
      sheet.insertRow(1, [title]);
      sheet.mergeCells(1, 1, 1, lastCol);
      const titleRow = sheet.getRow(1);
      titleRow.height = 26;
      titleRow.font = { bold: true, size: 14, color: { argb: BRAND_ARGB } };
      titleRow.alignment = { vertical: "middle" };

      const subtitle = `Del ${from.toLocaleDateString("es-AR")} al ${to.toLocaleDateString("es-AR")}`;
      sheet.insertRow(2, [subtitle]);
      sheet.mergeCells(2, 1, 2, lastCol);
      const subtitleRow = sheet.getRow(2);
      subtitleRow.font = { italic: true, color: { argb: "FF777777" } };

      const headerRowNumber = 3;
      const headerRow = sheet.getRow(headerRowNumber);
      headerRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_ARGB } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.border = CELL_BORDER;
      });
      sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
      sheet.autoFilter = {
        from: { row: headerRowNumber, column: 1 },
        to: { row: headerRowNumber, column: lastCol },
      };
      return headerRowNumber;
    }

    // Bordea y raya (colores alternados) las filas de datos debajo del
    // encabezado de una hoja.
    function styleDataRows(sheet, headerRowNumber) {
      for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const stripe = (r - headerRowNumber) % 2 === 0;
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.border = CELL_BORDER;
          if (stripe) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: STRIPE_ARGB } };
        });
      }
    }

    const resumen = workbook.addWorksheet("Resumen");
    resumen.columns = [
      { header: "Concepto", key: "concepto", width: 38 },
      { header: "Valor", key: "valor", width: 22 },
    ];
    resumen.addRows([
      { concepto: "Pedidos cerrados", valor: orderRows.length },
      { concepto: "Ventas totales", valor: ventasTotales },
      { concepto: "Descuentos otorgados", valor: descuentosTotales },
      { concepto: "Costo de mercadería vendida (insumos)", valor: cogs },
      { concepto: "Ganancia bruta", valor: gananciaBruta },
    ]);
    const resumenHeaderRow = addTitleBlock(resumen, "Cuenta de resultados");
    resumen.getCell(`B${resumenHeaderRow + 1}`).numFmt = "#,##0"; // pedidos cerrados: entero
    for (let r = resumenHeaderRow + 2; r <= resumen.rowCount; r++) {
      resumen.getCell(`B${r}`).numFmt = "#,##0.00";
    }
    resumen.getRow(resumenHeaderRow + 5).font = { bold: true }; // ganancia bruta destacada
    styleDataRows(resumen, resumenHeaderRow);

    const porProducto = workbook.addWorksheet("Ventas por producto");
    porProducto.columns = [
      { header: "Producto", key: "name", width: 32 },
      { header: "Cantidad vendida", key: "qty", width: 18 },
      { header: "Ingresos", key: "revenue", width: 18 },
    ];
    Object.values(productAgg)
      .sort((a, b) => b.revenue - a.revenue)
      .forEach((p) => porProducto.addRow(p));
    const porProductoHeaderRow = addTitleBlock(porProducto, "Ventas por producto");
    for (let r = porProductoHeaderRow + 1; r <= porProducto.rowCount; r++) {
      porProducto.getCell(`B${r}`).numFmt = "#,##0";
      porProducto.getCell(`C${r}`).numFmt = "#,##0.00";
    }
    styleDataRows(porProducto, porProductoHeaderRow);

    const porPago = workbook.addWorksheet("Pagos por medio");
    porPago.columns = [
      { header: "Medio de pago", key: "method", width: 20 },
      { header: "Total cobrado", key: "total", width: 18 },
    ];
    paymentRows.forEach((p) => porPago.addRow({ method: p.method, total: Number(p.total) }));
    const porPagoHeaderRow = addTitleBlock(porPago, "Pagos por medio");
    for (let r = porPagoHeaderRow + 1; r <= porPago.rowCount; r++) {
      porPago.getCell(`B${r}`).numFmt = "#,##0.00";
    }
    styleDataRows(porPago, porPagoHeaderRow);

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
