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
 *
 * Además, si el usuario NO tiene el permiso pero la request trae un header
 * "X-Override-Token" válido (obtenido en POST /api/auth/authorize-override
 * con el email/contraseña de alguien que sí tiene ese permiso — típicamente
 * un Encargado/Dueño/Admin autorizando "por arriba del hombro" a un Mozo),
 * la acción se deja pasar igual. Queda registrado en la auditoría quién
 * autorizó qué, para no perder trazabilidad.
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "No autenticado." });
    }
    if (hasPermission(req.user.role, permission)) {
      return next();
    }

    const overrideToken = req.headers["x-override-token"];
    if (overrideToken) {
      try {
        const payload = jwt.verify(overrideToken, process.env.JWT_SECRET);
        if (payload.type === "override" && payload.permission === permission) {
          req.override = { managerId: payload.managerId, managerName: payload.managerName, permission };
          return next();
        }
      } catch (err) {
        // token de autorización inválido/expirado: sigue al 403 de abajo
      }
    }

    return res
      .status(403)
      .json({ error: `No tenés permiso para realizar esta acción (${permission}).` });
  };
}

module.exports = { authenticate, requirePermission };
