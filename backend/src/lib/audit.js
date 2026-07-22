const { query } = require("../db/pool");

/**
 * Registra una acción relevante para trazabilidad. No lanza si falla el
 * registro de auditoría (no debería bloquear la operación principal), solo
 * lo reporta en consola.
 */
async function logAction({ userId, action, entity, entityId, details }) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)`,
      [userId || null, action, entity, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("No se pudo registrar el log de auditoría:", err.message);
  }
}

module.exports = { logAction };
