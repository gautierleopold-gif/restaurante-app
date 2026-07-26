// IVA / sales tax configurable por sucursal (ver branches.tax_rate/tax_mode
// y routes/settings.js): se comparte entre pedidos (routes/orders.js) y
// facturas libres (routes/freeInvoices.js) para que el cálculo sea idéntico
// en ambos casos.
// - NONE: no se aplica.
// - ADDITIVE: se suma por encima del subtotal (ya con descuento aplicado),
//   como un sales tax; el cliente paga subtotal + impuesto.
// - INCLUSIVE: el impuesto ya está incluido en los precios cargados; el
//   total no cambia, solo se discrimina el monto "contenido" para la factura.
function applyTax(subtotalAfterDiscount, taxRate, taxMode) {
  const rate = Number(taxRate) || 0;
  if (rate > 0 && taxMode === "ADDITIVE") {
    const taxAmount = subtotalAfterDiscount * (rate / 100);
    return { total: subtotalAfterDiscount + taxAmount, taxAmount };
  }
  if (rate > 0 && taxMode === "INCLUSIVE") {
    const taxAmount = subtotalAfterDiscount * (rate / (100 + rate));
    return { total: subtotalAfterDiscount, taxAmount };
  }
  return { total: subtotalAfterDiscount, taxAmount: 0 };
}

module.exports = { applyTax };
