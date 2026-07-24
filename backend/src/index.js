require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const authRoutes = require("./routes/auth");
const menuRoutes = require("./routes/menu");
const tableRoutes = require("./routes/tables");
const orderRoutes = require("./routes/orders");
const kitchenRoutes = require("./routes/kitchen");
const permissionRoutes = require("./routes/permissions");
const inventoryRoutes = require("./routes/inventory");
const settingsRoutes = require("./routes/settings");
const reportRoutes = require("./routes/reports");
const auditRoutes = require("./routes/audit");
const { pool } = require("./db/pool");
const { loadOverrides } = require("./lib/permissions");

const app = express();
const server = http.createServer(app);

const corsOrigin = process.env.CORS_ORIGIN || "*";
const io = new Server(server, {
  cors: { origin: corsOrigin },
});

app.set("io", io);

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "restaurante-backend", time: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api", tableRoutes); // /api/rooms, /api/tables
app.use("/api/orders", orderRoutes);
app.use("/api/kitchen", kitchenRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/audit", auditRoutes);

io.on("connection", (socket) => {
  socket.on("disconnect", () => {});
});

// Sirve el frontend (HTML/CSS/JS estático) desde el mismo servidor, así en
// producción alcanza con desplegar este backend: no hace falta un hosting
// separado para el frontend.
const frontendDir = path.join(__dirname, "..", "..", "frontend");
app.use(express.static(frontendDir));

// Manejo centralizado de errores -------------------------------------------
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Recurso no encontrado." });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.name === "ZodError") {
    return res.status(400).json({ error: "Datos inválidos.", details: err.issues });
  }
  const status = err.status || 500;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(status).json({ error: err.message || "Error interno del servidor." });
});

const PORT = process.env.PORT || 4000;

async function start() {
  // Carga en memoria las excepciones de permisos guardadas en la base
  // (Administración → Permisos). Si la tabla todavía no existe (por ejemplo
  // la primera vez que corre, antes de que termine db:migrate) simplemente
  // arranca con la matriz de permisos por defecto.
  try {
    const { rows } = await pool.query(`SELECT role, permission, allowed FROM role_permissions`);
    loadOverrides(rows);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("No se pudieron cargar los permisos configurables (se usa la matriz por defecto):", err.message);
  }

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend de gestión de restaurante corriendo en http://localhost:${PORT}`);
  });
}

start();
