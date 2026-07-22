/*
 * Aplica el esquema de base de datos (src/db/schema.sql) contra la base
 * configurada en DATABASE_URL. Es seguro correrlo varias veces: todas las
 * sentencias usan IF NOT EXISTS / manejo de excepciones para tipos.
 */
const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Aplicando esquema de base de datos...");
  await pool.query(sql);
  console.log("Esquema aplicado correctamente.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Error al aplicar el esquema:", err);
  process.exit(1);
});
