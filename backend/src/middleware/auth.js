const jwt = require("jsonwebtoken");
const { query } = require("../db/pool");
const { hasPermission } = require("../lib/permissions");

/**
 * Verifica el token JWT del header Authorization: Bearer <token>.
 * Adjunta el usuario autenticado (sin password_hash) en req.user.
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "No autenticado. Falta el token de acceso." });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      `SELECT id, name, email, role, active, branch_id FROM users WHERE id = $1`,
      [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ error: "Usuario inválido o inactivo." });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}

/**
 * Middleware factory: exige que el usuario autenticado tenga el permiso
 * indicado (ver src/lib/permissions.js). Debe usarse después de authenticate.
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "No autenticado." });
    }
    if (!hasPermission(req.user.role, permission)) {
      return res
        .status(403)
        .json({ error: `No tenés permiso para realizar esta acción (${permission}).` });
    }
    next();
  };
}

module.exports = { authenticate, requirePermission };
