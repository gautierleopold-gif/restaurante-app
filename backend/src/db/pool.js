const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("Error inesperado en el pool de PostgreSQL", err);
});

/**
 * Ejecuta una query simple. Uso: query('SELECT * FROM users WHERE id = $1', [id])
 */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Obtiene un cliente dedicado para ejecutar una transacción manual.
 * Recuerda liberar el cliente con client.release() al finalizar.
 */
async function getClient() {
  const client = await pool.connect();
  return client;
}

/**
 * Ejecuta una serie de operaciones dentro de una transacción.
 * fn recibe un `client` con el que debe hacer sus queries.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, getClient, withTransaction };
