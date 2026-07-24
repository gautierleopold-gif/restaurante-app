const PDFDocument = require("pdfkit");

/**
 * Genera el PDF de una factura/comprobante a partir del pedido, la factura
 * (número, datos del cliente) y los datos fiscales de la sucursal. Devuelve
 * un Buffer, así se puede tanto mandar como descarga como adjuntar a un
 * mail sin generarlo dos veces.
 */
function buildInvoicePdfBuffer({ branch, order, invoice }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const money = (n) => Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Encabezado con los datos fiscales del negocio
    doc.fontSize(18).text(branch?.legal_name || branch?.name || "Restaurante", { continued: false });
    doc.fontSize(9).fillColor("#555");
    if (branch?.tax_id) doc.text(`NIT / Identificación fiscal: ${branch.tax_id}`);
    if (branch?.fiscal_address || branch?.address) doc.text(branch.fiscal_address || branch.address);
    if (branch?.phone) doc.text(`Tel: ${branch.phone}`);
    doc.moveDown(1);
    doc.fillColor("#000");

    doc.fontSize(14).text(`Comprobante ${invoice.number}`, { align: "right" });
    doc.fontSize(9).fillColor("#555").text(
      `Fecha: ${new Date(invoice.created_at).toLocaleString("es-AR")}`,
      { align: "right" }
    );
    doc.text(`Pedido #${order.code}`, { align: "right" });
    doc.fillColor("#000");
    doc.moveDown(1);

    doc.fontSize(11).text("Cliente:", { underline: true });
    doc.fontSize(10);
    doc.text(invoice.customer_name || order.customer_name || "Consumidor final");
    if (invoice.customer_tax_id) doc.text(`NIT / Identificación: ${invoice.customer_tax_id}`);
    if (invoice.customer_email) doc.text(invoice.customer_email);
    doc.moveDown(1);

    // Tabla de ítems
    doc.fontSize(11).text("Detalle", { underline: true });
    doc.moveDown(0.3);
    const tableTop = doc.y;
    doc.fontSize(9).fillColor("#555");
    doc.text("Producto", 50, tableTop, { width: 260 });
    doc.text("Cant.", 310, tableTop, { width: 50, align: "right" });
    doc.text("P. unit.", 360, tableTop, { width: 80, align: "right" });
    doc.text("Subtotal", 450, tableTop, { width: 90, align: "right" });
    doc.moveTo(50, tableTop + 14).lineTo(540, tableTop + 14).strokeColor("#ccc").stroke();
    doc.fillColor("#000");

    let y = tableTop + 20;
    const items = (order.items || []).filter((it) => !it.canceled);
    for (const it of items) {
      const modsTotal = (it.modifiers || []).reduce((s, m) => s + Number(m.price), 0);
      const unitPrice = Number(it.unit_price) + modsTotal;
      const lineTotal = unitPrice * it.quantity;
      const name = `${it.product_name}${it.variant_name ? " (" + it.variant_name + ")" : ""}`;
      doc.fontSize(9).text(name, 50, y, { width: 260 });
      doc.text(String(it.quantity), 310, y, { width: 50, align: "right" });
      doc.text(`$${money(unitPrice)}`, 360, y, { width: 80, align: "right" });
      doc.text(`$${money(lineTotal)}`, 450, y, { width: 90, align: "right" });
      y += 18;
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
    }

    doc.moveTo(50, y + 4).lineTo(540, y + 4).strokeColor("#ccc").stroke();
    y += 14;
    doc.fontSize(10);
    doc.text(`Subtotal: $${money(invoice.subtotal)}`, 360, y, { width: 180, align: "right" });
    y += 16;
    if (Number(order.discount_percent) > 0) {
      doc.text(
        `Descuento (${order.discount_percent}%): -$${money(invoice.subtotal - invoice.total)}`,
        360,
        y,
        { width: 180, align: "right" }
      );
      y += 16;
    }
    doc.fontSize(13).text(`Total: $${money(invoice.total)}`, 360, y, { width: 180, align: "right" });

    doc.moveDown(3);
    doc.fontSize(8).fillColor("#888").text(
      "Comprobante generado por el sistema de gestión del restaurante. No válido como factura fiscal salvo que la configuración de datos fiscales del negocio esté completa y habilitada ante el organismo tributario correspondiente.",
      50,
      Math.max(doc.y, 720),
      { width: 490 }
    );

    doc.end();
  });
}

module.exports = { buildInvoicePdfBuffer };
