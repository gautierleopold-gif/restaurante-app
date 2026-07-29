const crypto = require("crypto");

// Guarda en memoria el resultado de parsear un archivo subido para importar
// (menú/adicionales/variantes), identificado por un token, para que el
// frontend no tenga que reenviar el archivo entero en cada paso (subir →
// previsualizar/mapear columnas → confirmar). Con el plan gratuito de Render
// corre una sola instancia del backend, así que un mapa en memoria alcanza;
// cada sesión expira sola a los 30 minutos para no acumular archivos viejos.

const TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

function put(data) {
  const token = crypto.randomUUID();
  const entry = { data, expiresAt: Date.now() + TTL_MS };
  sessions.set(token, entry);
  return token;
}

function get(token) {
  const entry = sessions.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return entry.data;
}

function cleanup() {
  const now = Date.now();
  for (const [token, entry] of sessions.entries()) {
    if (entry.expiresAt < now) sessions.delete(token);
  }
}
setInterval(cleanup, 5 * 60 * 1000).unref();

module.exports = { put, get };
