const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { logAction } = require("../lib/audit");
const { ALL_ROLES, hasPermission } = require("../lib/permissions");

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Email y contraseña son requeridos." });
  }
  const { email, password } = parsed.data;

  const { rows } = await query(
    `SELECT id, name, email, password_hash, role, active, branch_id FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user || !user.active) {
    return res.status(401).json({ error: "Credenciales inválidas." });
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Credenciales inválidas." });
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "12h",
  });

  await logAction({ userId: user.id, action: "LOGIN", entity: "User", entityId: user.id });

  delete user.password_hash;
  res.json({ token, user });
});

router.get("/me", authenticate, async (req, res) => {
  res.json({ user: req.user });
});

// Autorización de un supervisor ("manager override"): un Mozo/Cajero/Cocina
// puede pedirle a un Encargado/Dueño/Admin que autorice, con su propio
// email y contraseña, una acción puntual para la que el usuario logueado no
// tiene permiso (por ejemplo anular un ítem o aplicar un descuento), sin que
// nadie tenga que cerrar sesión. Devuelve un token de corta duración (5
// minutos) válido solo para ese permiso puntual.
const overrideSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  permission: z.string().min(1),
});

router.post("/authorize-override", authenticate, async (req, res) => {
  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Datos inválidos." });
  }
  const { email, password, permission } = parsed.data;

  const { rows } = await query(
    `SELECT id, name, email, password_hash, role, active FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  const manager = rows[0];
  if (!manager || !manager.active) {
    return res.status(401).json({ error: "Credenciales inválidas." });
  }
  const valid = await bcrypt.compare(password, manager.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Credenciales inválidas." });
  }
  if (!hasPermission(manager.role, permission)) {
    return res.status(403).json({ error: "Esa persona no tiene permiso para autorizar esta acción." });
  }

  const overrideToken = jwt.sign(
    { type: "override", permission, managerId: manager.id, managerName: manager.name },
    process.env.JWT_SECRET,
    { expiresIn: "5m" }
  );

  await logAction({
    userId: req.user.id,
    action: "OVERRIDE_AUTHORIZED",
    entity: "Permission",
    entityId: permission,
    details: { authorizedBy: manager.id, authorizedByName: manager.name, forUser: req.user.id },
  });

  res.json({ overrideToken, managerName: manager.name });
});

// Cualquier usuario autenticado puede cambiar su propia contraseña (no hace
// falta un permiso especial, con estar logueado alcanza). Esto no reemplaza
// un flujo de "olvidé mi contraseña" (para eso sigue haciendo falta que un
// Admin/Dueño cree una cuenta nueva o resetee la existente).
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

router.post("/me/password", authenticate, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Datos inválidos.", details: parsed.error.issues });
  }
  const { currentPassword, newPassword } = parsed.data;

  const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
  const valid = rows[0] && (await bcrypt.compare(currentPassword, rows[0].password_hash));
  if (!valid) {
    return res.status(401).json({ error: "La contraseña actual no es correcta." });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, req.user.id]);

  await logAction({ userId: req.user.id, action: "PASSWORD_CHANGED", entity: "User", entityId: req.user.id });

  res.json({ ok: true });
});

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(ALL_ROLES),
  branchId: z.string().uuid().nullable().optional(),
});

// Crear usuarios: solo ADMIN o DUENIO
router.post("/users", authenticate, requirePermission("users:manage"), async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Datos inválidos.", details: parsed.error.issues });
  }
  const { name, email, password, role, branchId } = parsed.data;

  const existing = await query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: "Ya existe un usuario con ese email." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role, branch_id) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, email, role, active, branch_id, created_at`,
    [name, email.toLowerCase(), passwordHash, role, branchId || null]
  );

  await logAction({
    userId: req.user.id,
    action: "USER_CREATED",
    entity: "User",
    entityId: rows[0].id,
    details: { role },
  });

  res.status(201).json({ user: rows[0] });
});

router.get("/users", authenticate, requirePermission("users:manage"), async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, email, role, active, branch_id, created_at FROM users ORDER BY created_at DESC`
  );
  res.json({ users: rows });
});

router.patch("/users/:id", authenticate, requirePermission("users:manage"), async (req, res) => {
  const { id } = req.params;
  const patchSchema = z.object({
    name: z.string().min(1).optional(),
    role: z.enum(ALL_ROLES).optional(),
    active: z.boolean().optional(),
  });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Datos inválidos." });
  }
  const fields = parsed.data;
  const keys = Object.keys(fields);
  if (keys.length === 0) {
    return res.status(400).json({ error: "Nada para actualizar." });
  }
  const setClause = keys.map((k, i) => `${k === "active" ? "active" : k} = $${i + 1}`).join(", ");
  const values = keys.map((k) => fields[k]);
  const { rows } = await query(
    `UPDATE users SET ${setClause} WHERE id = $${keys.length + 1}
     RETURNING id, name, email, role, active, branch_id`,
    [...values, id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });

  await logAction({ userId: req.user.id, action: "USER_UPDATED", entity: "User", entityId: id, details: fields });
  res.json({ user: rows[0] });
});

module.exports = router;
