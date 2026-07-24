/**
 * Descuento/reposición automática de stock según la receta de cada producto
 * (tabla product_ingredients). Se llama desde routes/orders.js cada vez que
 * cambia la cantidad "efectiva" vendida de un producto dentro de un pedido:
 * al agregar un ítem (delta positivo), al editar su cantidad (delta = nueva
 * - vieja) y al anular un ítem (delta negativo, repone lo consumido).
 *
 * Si el producto no tiene receta cargada (caso normal en la mayoría de los
 * negocios que no quieran llevar inventario a ese nivel de detalle), esta
 * función no hace nada.
 */
async function applyStockDelta(client, { productId, deltaQuantity, orderId, userId, reason }) {
  if (!deltaQuantity) return;
  const { rows: recipe } = await client.query(
    `SELECT ingredient_id, quantity FROM product_ingredients WHERE product_id = $1`,
    [productId]
  );
  if (recipe.length === 0) return;

  for (const r of recipe) {
    const consumed = Number(r.quantity) * deltaQuantity; // positivo = consume stock, negativo = repone
    await client.query(`UPDATE ingredients SET stock = stock - $1 WHERE id = $2`, [consumed, r.ingredient_id]);
    await client.query(
      `INSERT INTO stock_movements (ingredient_id, type, quantity, reason, order_id, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.ingredient_id, consumed >= 0 ? "SALIDA" : "ENTRADA", Math.abs(consumed), reason, orderId || null, userId || null]
    );
  }
}

module.exports = { applyStockDelta };
