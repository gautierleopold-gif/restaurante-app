const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const { query } = require("../db/pool");
const { authenticate, requirePermission } = require("../middleware/auth");
const { logAction } = require("../lib/audit");
const { ALL_ROLES } = require("../lib/permissions");

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
