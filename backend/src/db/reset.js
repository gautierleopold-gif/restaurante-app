/*
 * Borra todas las tablas y tipos del esquema (¡destructivo!). Útil en
 * desarrollo para volver a empezar de cero. Luego de correr esto hay que
 * volver a ejecutar `npm run db:migrate` y `npm run db:seed`.
 */
const { pool } = require("./pool");

const DROP_SQL = `
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS order_item_modifiers CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP SEQUENCE IF EXISTS orders_code_seq CASCADE;
DROP TABLE IF EXISTS tables CASCADE;
DROP TABLE IF EXISTS rooms CASCADE;
DROP TABLE IF EXISTS product_modifier_groups CASCADE;
DROP TABLE IF EXISTS modifiers CASCADE;
DROP TABLE IF EXISTS modifier_groups CASCADE;
DROP TABLE IF EXISTS product_variants CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS stations CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS branches CASCADE;
DROP TYPE IF EXISTS payment_method CASCADE;
DROP TYPE IF EXISTS kitchen_status CASCADE;
DROP TYPE IF EXISTS order_status CASCADE;
DROP TYPE IF EXISTS order_type CASCADE;
DROP TYPE IF EXISTS table_status CASCADE;
DROP TYPE IF EXISTS role_name CASCADE;
`;

async function reset() {
  console.log("Borrando todas las tablas y tipos...");
  await pool.query(DROP_SQL);
  console.log("Listo. Corre 'npm run db:migrate' y 'npm run db:seed' para reconstruir.");
  await pool.end();
}

reset().catch((err) => {
  console.error("Error al resetear la base de datos:", err);
  process.exit(1);
});
