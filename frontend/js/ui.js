// Utilidades de interfaz compartidas: navegación superior, toasts y modales.

const NAV_LINKS = [
  { href: "/pages/salon.html", label: "Salón", roles: ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO", "COCINA"] },
  { href: "/pages/pos.html", label: "Nuevo pedido", roles: ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO"] },
  { href: "/pages/pedidos.html", label: "Pedidos", roles: ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO"] },
  { href: "/pages/cocina.html", label: "Cocina", roles: ["ADMIN", "DUENIO", "ENCARGADO", "COCINA", "MOZO"] },
  { href: "/pages/admin.html", label: "Administración", roles: ["ADMIN", "DUENIO", "ENCARGADO"] },
];

const ROLE_LABELS = {
  ADMIN: "Administrador",
  DUENIO: "Dueño/Gerente",
  ENCARGADO: "Encargado",
  CAJERO: "Cajero",
  MOZO: "Mozo",
  COCINA: "Cocina",
};

function renderNav() {
  const user = getUser();
  if (!user) return;
  const mount = document.getElementById("app-nav");
  if (!mount) return;

  const current = location.pathname;
  const links = NAV_LINKS.filter((l) => l.roles.includes(user.role))
    .map((l) => `<a href="${l.href}" class="${current === l.href ? "active" : ""}">${l.label}</a>`)
    .join("");

  mount.innerHTML = `
    <div class="topbar">
      <div class="brand">🍽️ Gestión Restaurante</div>
      <nav>${links}</nav>
      <div class="userbox">
        <span>${user.name}</span>
        <span class="badge-role">${ROLE_LABELS[user.role] || user.role}</span>
        <button class="btn btn-ghost btn-sm" id="logout-btn">Salir</button>
      </div>
    </div>
  `;
  document.getElementById("logout-btn").addEventListener("click", () => {
    clearSession();
    location.href = "/index.html";
  });
}

function requireAuth() {
  const user = getUser();
  const token = getToken();
  if (!user || !token) {
    location.href = "/index.html";
    return null;
  }
  return user;
}

function requireRole(roles) {
  const user = requireAuth();
  if (!user) return null;
  if (!roles.includes(user.role)) {
    document.body.innerHTML = `
      <div class="container">
        <div class="card empty-state">
          <h2>Acceso restringido</h2>
          <p>Tu rol (${ROLE_LABELS[user.role] || user.role}) no tiene acceso a esta sección.</p>
          <a class="btn btn-primary" href="/pages/salon.html">Volver al salón</a>
        </div>
      </div>`;
    return null;
  }
  return user;
}

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "error" : type === "success" ? "success" : ""}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function showModal(innerHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal">${innerHtml}</div>`;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  return overlay;
}

function closeModal(overlay) {
  if (overlay && overlay.remove) overlay.remove();
}

function connectSocket() {
  if (typeof io === "undefined") return null;
  const socket = io({ transports: ["websocket", "polling"] });
  return socket;
}
