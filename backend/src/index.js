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
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend de gestión de restaurante corriendo en http://localhost:${PORT}`);
});
