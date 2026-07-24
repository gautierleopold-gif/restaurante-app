/**
 * Matriz de permisos por rol.
 *
 * DEFAULT_PERMISSIONS es el punto de partida ("de fábrica") de qué puede
 * hacer cada rol. Desde Administración → Permisos, un Admin/Dueño puede
 * activar o desactivar acciones puntuales por rol: esas excepciones se
 * guardan en la tabla `role_permissions` y se cargan acá en memoria (ver
 * loadOverrides), sin tener que tocar este archivo ni reiniciar el server.
 *
 * ADMIN es un "superusuario": siempre tiene todos los permisos, sin importar
 * los overrides guardados. Esto es intencional para que nunca sea posible
 * quitarle a todos los administradores el acceso a la propia pantalla de
 * permisos (y quedar la app sin nadie que pueda revertir el cambio).
 *
 * Roles: ADMIN, DUENIO, ENCARGADO, CAJERO, MOZO, COCINA
 */

const ALL_ROLES = ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO", "COCINA"];

const DEFAULT_PERMISSIONS = {
  // Usuarios y configuración del sistema
  "users:manage": ["ADMIN", "DUENIO"],
  "branches:manage": ["ADMIN", "DUENIO"],
  "permissions:manage": ["ADMIN", "DUENIO"],
  "settings:manage": ["ADMIN", "DUENIO"],
  "audit:view": ["ADMIN", "DUENIO"],

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

  // Facturación
  "invoices:issue": ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO"],

  // Cocina / KDS
  "kitchen:view": ["ADMIN", "DUENIO", "ENCARGADO", "COCINA", "MOZO"],
  "kitchen:updateStatus": ["ADMIN", "DUENIO", "ENCARGADO", "COCINA"],

  // Inventario
  "inventory:view": ["ADMIN", "DUENIO", "ENCARGADO", "COCINA"],
  "inventory:manage": ["ADMIN", "DUENIO", "ENCARGADO"],

  // Reportes
  "reports:view": ["ADMIN", "DUENIO", "ENCARGADO"],
};

// Etiquetas legibles para mostrar en la pantalla de Permisos, agrupadas por
// categoría. Si se agrega un permiso nuevo y no tiene entrada acá, se
// muestra la clave técnica tal cual (no rompe nada, solo es menos lindo).
const PERMISSION_GROUPS = [
  {
    label: "Usuarios y sistema",
    permissions: [
      ["users:manage", "Crear y administrar usuarios"],
      ["branches:manage", "Administrar sucursales"],
      ["permissions:manage", "Configurar permisos por rol"],
      ["settings:manage", "Editar parámetros del restaurante"],
      ["audit:view", "Ver el registro de auditoría"],
    ],
  },
  {
    label: "Menú",
    permissions: [
      ["menu:view", "Ver el menú"],
      ["menu:manage", "Editar productos, categorías y adicionales"],
    ],
  },
  {
    label: "Salón y mesas",
    permissions: [
      ["tables:view", "Ver el salón"],
      ["tables:manage", "Editar salones y mesas"],
    ],
  },
  {
    label: "Pedidos (POS)",
    permissions: [
      ["orders:view", "Ver pedidos"],
      ["orders:create", "Crear pedidos"],
      ["orders:update", "Editar pedidos (agregar productos, enviar a cocina)"],
      ["orders:discount", "Aplicar descuentos"],
      ["orders:cancelItem", "Anular ítems o pedidos"],
      ["orders:close", "Cerrar pedidos"],
      ["payments:register", "Registrar pagos"],
      ["invoices:issue", "Emitir facturas"],
    ],
  },
  {
    label: "Cocina",
    permissions: [
      ["kitchen:view", "Ver el tablero de cocina"],
      ["kitchen:updateStatus", "Avanzar el estado de las comandas"],
    ],
  },
  {
    label: "Inventario",
    permissions: [
      ["inventory:view", "Ver el inventario"],
      ["inventory:manage", "Editar insumos, recetas y stock"],
    ],
  },
  {
    label: "Reportes",
    permissions: [["reports:view", "Ver y exportar reportes"]],
  },
];

// Cache en memoria de las excepciones guardadas en `role_permissions`.
// clave: "ROL|permiso" -> boolean
let overrides = {};

function overrideKey(role, permission) {
  return `${role}|${permission}`;
}

function loadOverrides(rows) {
  const next = {};
  for (const row of rows) {
    next[overrideKey(row.role, row.permission)] = row.allowed;
  }
  overrides = next;
}

function setOverrideInMemory(role, permission, allowed) {
  if (allowed === null || allowed === undefined) {
    delete overrides[overrideKey(role, permission)];
  } else {
    overrides[overrideKey(role, permission)] = allowed;
  }
}

function hasPermission(role, permission) {
  if (role === "ADMIN") return true; // superusuario, ver comentario arriba
  const key = overrideKey(role, permission);
  if (Object.prototype.hasOwnProperty.call(overrides, key)) {
    return overrides[key];
  }
  const allowed = DEFAULT_PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.includes(role);
}

function getEffectiveMatrix() {
  return PERMISSION_GROUPS.map((group) => ({
    label: group.label,
    permissions: group.permissions.map(([key, label]) => ({
      key,
      label,
      roles: Object.fromEntries(ALL_ROLES.map((role) => [role, hasPermission(role, key)])),
      defaults: Object.fromEntries(
        ALL_ROLES.map((role) => [role, role === "ADMIN" ? true : (DEFAULT_PERMISSIONS[key] || []).includes(role)])
      ),
    })),
  }));
}

module.exports = {
  ALL_ROLES,
  DEFAULT_PERMISSIONS,
  PERMISSION_GROUPS,
  hasPermission,
  loadOverrides,
  setOverrideInMemory,
  getEffectiveMatrix,
};
