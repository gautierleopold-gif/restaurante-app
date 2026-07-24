const express = require("express");
const { z } = require("zod");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");
const { logAction } = require("../lib/audit");
const { ALL_ROLES, DEFAULT_PERMISSIONS, getEffectiveMatrix, setOverrideInMemory } = require("../lib/permissions");

const router = express.Router();
router.use(authenticate);

router.get(
  "/",
  requirePermission("permissions:manage"),
  asyncHandler(async (req, res) => {
    res.json({ roles: ALL_ROLES, groups: getEffectiveMatrix() });
  })
);

const updateSchema = z.object({
  role: z.enum(ALL_ROLES),
  permission: z.string().min(1),
  allowed: z.boolean().nullable(), // null = volver al valor por defecto
});

router.put(
  "/",
  requirePermission("permissions:manage"),
  asyncHandler(async (req, res) => {
    const { role, permission, allowed } = updateSchema.parse(req.body);

    if (!DEFAULT_PERMISSIONS[permission]) {
      return res.status(400).json({ error: "Ese permiso no existe." });
    }
    if (role === "ADMIN") {
      return res.status(400).json({
        error: "El rol Administrador siempre tiene todos los permisos; no se puede restringir, para evitar quedar sin acceso.",
      });
    }

    if (allowed === null) {
      await query(`DELETE FROM role_permissions WHERE role = $1 AND permission = $2`, [role, permission]);
    } else {
      await query(
        `INSERT INTO role_permissions (role, permission, allowed, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (role, permission) DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()`,
        [role, permission, allowed]
      );
    }
    setOverrideInMemory(role, permission, allowed);

    await logAction({
      userId: req.user.id,
      action: "PERMISSION_UPDATED",
      entity: "RolePermission",
      entityId: `${role}:${permission}`,
      details: { role, permission, allowed },
    });

    res.json({ groups: getEffectiveMatrix() });
  })
);

module.exports = router;
