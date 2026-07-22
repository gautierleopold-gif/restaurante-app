/**
 * Matriz de permisos por rol.
 *
 * Este es el punto único donde se define "qué puede hacer cada rol". En
 * fases futuras esto podría moverse a la base de datos para permitir que un
 * administrador edite los permisos desde la interfaz, pero para el MVP se
 * define en código para simplificar la implementación.
 *
 * Roles: ADMIN, DUENIO, ENCARGADO, CAJERO, MOZO, COCINA
 */

const ALL_ROLES = ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO", "COCINA"];

const PERMISSIONS = {
  // Usuarios y configuración del sistema
  "users:manage": ["ADMIN", "DUENIO"],
  "branches:manage": ["ADMIN", "DUENIO"],

  // Menú / productos
  "menu:view": ALL_ROLES,
  "menu:manage": ["ADMIN", "DUENIO", "ENCARGADO"],

  // Salón y mesas
  "tables:view": ALL_ROLES,
  "tables:manage": ["ADMIN", "DUENIO", "ENCARGADO"],

  // Pedidos (POS)
  "orders:view": ALL_ROLES,
  "orders:create": ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO"],
  "orders:update": ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO"],
  "orders:discount": ["ADMIN", "DUENIO", "ENCARGADO"],
  "orders:cancelItem": ["ADMIN", "DUENIO", "ENCARGADO"],
  "orders:close": ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO"],

  // Pagos
  "payments:register": ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO"],

  // Cocina / KDS
  "kitchen:view": ["ADMIN", "DUENIO", "ENCARGADO", "COCINA", "MOZO"],
  "kitchen:updateStatus": ["ADMIN", "DUENIO", "ENCARGADO", "COCINA"],

  // Reportes (fase futura, dejado preparado)
  "reports:view": ["ADMIN", "DUENIO", "ENCARGADO"],
};

function hasPermission(role, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.includes(role);
}

module.exports = { PERMISSIONS, ALL_ROLES, hasPermission };
