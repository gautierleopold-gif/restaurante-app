const PDFDocument = require("pdfkit");

/**
 * Genera el PDF de una factura/comprobante a partir del pedido, la factura
 * (número, datos del cliente), los datos fiscales de la sucursal y,
 * opcionalmente, una plantilla (logo, colores, textos de encabezado/pie y un
 * preset de estilo -- ver routes/invoiceTemplates.js). Sin plantilla usa el
 * diseño de fábrica de siempre. Devuelve un Buffer, así se puede tanto
 * mandar como descarga como adjuntar a un mail sin generarlo dos veces.
 */
function buildInvoicePdfBuffer({ branch, order, invoice, template }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const money = (n) => Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const layout = template?.layout || "CLASICO";
    // En MINIMAL se evita el color de acento para un look más austero
    // (blanco y negro); en CLASICO/MODERNO se usa para títulos y líneas.
    const accentColor = layout === "MINIMAL" ? "#000000" : template?.accent_color || "#2F5233";
    const lineColor = layout === "MINIMAL" ? "#000000" : "#ccc";

    // Logo (opcional, subido como imagen y guardado en base64): se dibuja
    // arriba a la izquierda y se corre el texto del encabezado a la derecha
    // para no superponerse.
    let headerX = 50;
    if (template?.logo_base64) {
      try {
        const base64Data = template.logo_base64.split(",").pop();
        const imgBuffer = Buffer.from(base64Data, "base64");
        doc.image(imgBuffer, 50, 45, { fit: [70, 70] });
        headerX = 130;
      } catch (err) {
        // Logo corrupto/formato no soportado: se ignora y sigue sin logo en
        // vez de romper la generación de la factura.
      }
    }

    // Encabezado con los datos fiscales del negocio
    doc.fontSize(18).fillColor("#000").text(branch?.legal_name || branch?.name || "Restaurante", headerX, 50);
    doc.fontSize(9).fillColor("#555");
    if (template?.header_text) doc.text(template.header_text, headerX, doc.y);
    if (branch?.tax_id) doc.text(`NIT / Identificación fiscal: ${branch.tax_id}`, headerX, doc.y);
    if (branch?.fiscal_address || branch?.address) doc.text(branch.fiscal_address || branch.address, headerX, doc.y);
    if (branch?.phone) doc.text(`Tel: ${branch.phone}`, headerX, doc.y);
    doc.y = Math.max(doc.y, 115);
    doc.x = 50;
    doc.moveDown(0.5);
    doc.fillColor("#000");

    doc.fontSize(14).fillColor(accentColor).text(`Comprobante ${invoice.number}`, { align: "right" });
    doc.fontSize(9).fillColor("#555").text(
      `Fecha: ${new Date(invoice.created_at).toLocaleString("es-AR")}`,
      { align: "right" }
    );
    if (order.code) doc.text(`Pedido #${order.code}`, { align: "right" });
    doc.fillColor("#000");
    doc.moveDown(1);

    doc.fontSize(11).fillColor(accentColor).text("Cliente:", { underline: true });
    doc.fontSize(10).fillColor("#000");
    doc.text(invoice.customer_name || order.customer_name || "Consumidor final");
    if (invoice.customer_tax_id) doc.text(`NIT / Identificación: ${invoice.customer_tax_id}`);
    if (invoice.customer_email) doc.text(invoice.customer_email);
    doc.moveDown(1);

    // Tabla de ítems
    doc.fontSize(11).fillColor(accentColor).text("Detalle", { underline: true });
    doc.fillColor("#000");
    doc.moveDown(0.3);
    const tableTop = doc.y;
    doc.fontSize(9).fillColor("#555");
    doc.text("Producto", 50, tableTop, { width: 260 });
    doc.text("Cant.", 310, tableTop, { width: 50, align: "right" });
    doc.text("P. unit.", 360, tableTop, { width: 80, align: "right" });
    doc.text("Subtotal", 450, tableTop, { width: 90, align: "right" });
    doc.moveTo(50, tableTop + 14).lineTo(540, tableTop + 14).strokeColor(lineColor).stroke();
    doc.fillColor("#000");

    let y = tableTop + 20;
    const items = (order.items || []).filter((it) => !it.canceled);
    for (const it of items) {
      const modsTotal = (it.modifiers || []).reduce((s, m) => s + Number(m.price), 0);
      const unitPrice = Number(it.unit_price) + modsTotal;
      const lineTotal = unitPrice * it.quantity;
      const name = `${it.product_name}${it.variant_name ? " (" + it.variant_name + ")" : ""}`;
      doc.fontSize(9).fillColor("#000").text(name, 50, y, { width: 260 });
      doc.text(String(it.quantity), 310, y, { width: 50, align: "right" });
      doc.text(`$${money(unitPrice)}`, 360, y, { width: 80, align: "right" });
      doc.text(`$${money(lineTotal)}`, 450, y, { width: 90, align: "right" });
      y += 14;
      if ((it.modifiers || []).length > 0) {
        const modsTxt = it.modifiers
          .map((m) => (Number(m.quantity) > 1 ? `${m.quantity}x ${m.modifier_name}` : m.modifier_name))
          .join(", ");
        doc.fontSize(8).fillColor("#777").text(modsTxt, 50, y, { width: 480 });
        y += 12;
      }
      y += 6;
      if (y > 690) {
        doc.addPage();
        y = 50;
      }
    }

    doc.moveTo(50, y + 4).lineTo(540, y + 4).strokeColor(lineColor).stroke();
    y += 14;
    doc.fontSize(10).fillColor("#000");
    doc.text(`Subtotal: $${money(invoice.subtotal)}`, 360, y, { width: 180, align: "right" });
    y += 16;
    const discountPercent = Number(order.discount_percent || 0);
    if (discountPercent > 0) {
      const discountAmount = (Number(invoice.subtotal) * discountPercent) / 100;
      doc.text(`Descuento (${discountPercent}%): -$${money(discountAmount)}`, 360, y, { width: 180, align: "right" });
      y += 16;
    }
    const taxAmount = Number(invoice.tax_amount || 0);
    if (taxAmount > 0) {
      const taxLabel = invoice.tax_label || "IVA";
      const modeSuffix = invoice.tax_mode === "INCLUSIVE" ? " (incluido)" : "";
      doc.text(
        `${taxLabel} (${money(invoice.tax_rate)}%)${modeSuffix}: $${money(taxAmount)}`,
        360,
        y,
        { width: 180, align: "right" }
      );
      y += 16;
    }
    doc.fontSize(13).fillColor(accentColor).text(`Total: $${money(invoice.total)}`, 360, y, { width: 180, align: "right" });
    doc.fillColor("#000");

    doc.moveDown(3);
    const footerY = Math.max(doc.y, 720);
    doc.fontSize(8).fillColor("#888").text(
      "Comprobante generado por el sistema de gestión del restaurante. No válido como factura fiscal salvo que la configuración de datos fiscales del negocio esté completa y habilitada ante el organismo tributario correspondiente.",
      50,
      footerY,
      { width: 490 }
    );
    if (template?.footer_text) {
      doc.fontSize(8).fillColor("#555").text(template.footer_text, 50, doc.y + 4, { width: 490 });
    }

    doc.end();
  });
}

module.exports = { buildInvoicePdfBuffer };
