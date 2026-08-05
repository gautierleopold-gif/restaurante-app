// Utilidades de interfaz compartidas: navegación superior, toasts y modales.

const NAV_LINKS = [
  { href: "/pages/salon.html", key: "nav.salon", roles: ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO", "COCINA"] },
  { href: "/pages/pos.html", key: "nav.nuevoPedido", roles: ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO"] },
  { href: "/pages/pedidos.html", key: "nav.pedidos", roles: ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO"] },
  { href: "/pages/cocina.html", key: "nav.cocina", roles: ["ADMIN", "DUENIO", "ENCARGADO", "COCINA", "MOZO"] },
  { href: "/pages/caja.html", key: "nav.caja", roles: ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO"] },
  { href: "/pages/admin.html", key: "nav.admin", roles: ["ADMIN", "DUENIO", "ENCARGADO"] },
  { href: "/pages/ayuda.html", key: "nav.ayuda", roles: ["ADMIN", "DUENIO", "ENCARGADO", "CAJERO", "MOZO", "COCINA"] },
];

// Etiquetas "de fábrica" en español; si i18n.js está cargado, ROLE_LABEL(role)
// usa la traducción según el idioma configurado en la sucursal.
const ROLE_LABELS = {
  ADMIN: "Administrador",
  DUENIO: "Dueño/Gerente",
  ENCARGADO: "Encargado",
  CAJERO: "Cajero",
  MOZO: "Mozo",
  COCINA: "Cocina",
};

function roleLabel(role) {
  if (typeof t === "function") return t(`role.${role}`, ROLE_LABELS[role] || role);
  return ROLE_LABELS[role] || role;
}

function renderNav() {
  const user = getUser();
  if (!user) return;
  const mount = document.getElementById("app-nav");
  if (!mount) return;

  const current = location.pathname;
  const tr = typeof t === "function" ? t : (key, fallback) => fallback || key;
  const links = NAV_LINKS.filter((l) => l.roles.includes(user.role))
    .map((l) => `<a href="${l.href}" class="${current === l.href ? "active" : ""}" data-i18n="${l.key}">${tr(l.key)}</a>`)
    .join("");

  mount.innerHTML = `
    <div class="topbar">
      <div class="brand">🍽️ Gestión Restaurante</div>
      <nav>${links}</nav>
      <div class="userbox">
        <span>${user.name}</span>
        <span class="badge-role">${roleLabel(user.role)}</span>
        <button class="btn btn-ghost btn-sm" id="change-password-btn" data-i18n="btn.changePassword">${tr("btn.changePassword")}</button>
        <button class="btn btn-ghost btn-sm" id="logout-btn" data-i18n="btn.logout">${tr("btn.logout")}</button>
      </div>
    </div>
  `;
  document.getElementById("logout-btn").addEventListener("click", () => {
    clearSession();
    location.href = "/index.html";
  });
  document.getElementById("change-password-btn").addEventListener("click", openChangePasswordModal);
}

function openChangePasswordModal() {
  const tr = typeof t === "function" ? t : (key, fallback) => (typeof fallback === "string" ? fallback : key);
  const overlay = showModal(`
    <h2>${tr("ui.changePassword.title", "Cambiar mi contraseña")}</h2>
    <div class="field"><label>${tr("ui.changePassword.currentLabel", "Contraseña actual")}</label><input id="cp-current" type="password" /></div>
    <div class="field"><label>${tr("ui.changePassword.newLabel", "Contraseña nueva (mínimo 6 caracteres)")}</label><input id="cp-new" type="password" /></div>
    <div class="field"><label>${tr("ui.changePassword.repeatLabel", "Repetir contraseña nueva")}</label><input id="cp-new2" type="password" /></div>
    <button class="btn btn-primary" id="cp-save">${tr("btn.save", "Guardar")}</button>
  `);
  overlay.querySelector("#cp-save").addEventListener("click", async () => {
    const currentPassword = overlay.querySelector("#cp-current").value;
    const newPassword = overlay.querySelector("#cp-new").value;
    const newPassword2 = overlay.querySelector("#cp-new2").value;
    if (newPassword.length < 6) {
      toast(tr("ui.changePassword.tooShortError", "La contraseña nueva debe tener al menos 6 caracteres."), "error");
      return;
    }
    if (newPassword !== newPassword2) {
      toast(tr("ui.changePassword.mismatchError", "Las contraseñas nuevas no coinciden."), "error");
      return;
    }
    try {
      await api("/auth/me/password", { method: "POST", body: { currentPassword, newPassword } });
      closeModal(overlay);
      toast(tr("ui.changePassword.updatedToast", "Contraseña actualizada."), "success");
    } catch (err) {
      toast(err.message, "error");
    }
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
    const tr = typeof t === "function" ? t : (key, fallback) => (typeof fallback === "string" ? fallback : key);
    document.body.innerHTML = `
      <div class="container">
        <div class="card empty-state">
          <h2>${tr("ui.accessRestricted.title", "Acceso restringido")}</h2>
          <p>${tr("ui.accessRestricted.text", { role: roleLabel(user.role) })}</p>
          <a class="btn btn-primary" href="/pages/salon.html">${tr("pos.actions.backToSalonBtn", "Volver al salón")}</a>
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
