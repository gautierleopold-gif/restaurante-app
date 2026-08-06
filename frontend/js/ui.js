// Utilidades de interfaz compartidas: navegación superior, toasts, modales e íconos.

// Set de íconos propio en SVG (reemplaza los emojis que se usaban antes como
// iconografía, que se ven distinto según sistema operativo/navegador). Cada
// ícono hereda el color del texto (stroke="currentColor") para combinar con
// cualquier botón o estado sin necesidad de variantes por color.
const ICONS = {
  plate:
    '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="1.6"/><circle cx="12" cy="12" r="4.2" stroke-width="1.6"/></svg>',
  note:
    '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M4 3h13l3 3v15H4z" stroke-width="1.6" stroke-linejoin="round"/><path d="M17 3v3h3" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 10h8M8 14h8M8 18h4" stroke-width="1.6" stroke-linecap="round"/></svg>',
  printer:
    '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M6 9V3h12v6" stroke-width="1.6" stroke-linejoin="round"/><rect x="4" y="9" width="16" height="8" rx="1.5" stroke-width="1.6"/><path d="M7 21h10v-5H7z" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M12 3.5 21 20H3z" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9.5v5" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="1.6"/><path d="M8 12.5l2.7 2.7L16.5 9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-width="1.8" stroke-linecap="round"/></svg>',
  upload:
    '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M12 16V4M7 8l5-5 5 5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke-width="1.6" stroke-linecap="round"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function icon(name, extraClass) {
  const svg = ICONS[name];
  if (!svg) return "";
  if (!extraClass) return svg;
  return svg.replace('class="icon"', `class="icon ${extraClass}"`);
}

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
    <header class="topbar">
      <div class="brand">${icon("plate")} Gestión Restaurante</div>
      <nav aria-label="${tr("ui.nav.ariaLabel", "Navegación principal")}">${links}</nav>
      <div class="userbox">
        <span>${user.name}</span>
        <span class="badge-role">${roleLabel(user.role)}</span>
        <button class="btn btn-ghost btn-sm" id="change-password-btn" data-i18n="btn.changePassword">${tr("btn.changePassword")}</button>
        <button class="btn btn-ghost btn-sm" id="logout-btn" data-i18n="btn.logout">${tr("btn.logout")}</button>
      </div>
    </header>
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

// Modal de confirmación propio, para no depender de confirm() nativo del
// navegador (que rompe la identidad visual de la app) en acciones
// destructivas. Devuelve una Promise<boolean>: true si se confirmó.
function confirmModal(message, opts) {
  const tr = typeof t === "function" ? t : (key, fallback) => (typeof fallback === "string" ? fallback : key);
  const options = opts || {};
  const title = options.title || tr("ui.confirm.defaultTitle", "Confirmar");
  const confirmLabel = options.confirmLabel || tr("btn.confirm", "Confirmar");
  const cancelLabel = options.cancelLabel || tr("btn.cancel", "Cancelar");
  const danger = options.danger !== false;
  return new Promise((resolve) => {
    const overlay = showModal(`
      <h2>${title}</h2>
      <p class="modal-text">${message}</p>
      <div class="modal-actions">
        <button class="btn" data-action="cancel">${cancelLabel}</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-action="confirm">${confirmLabel}</button>
      </div>
    `);
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal(overlay);
      resolve(value);
    };
    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => finish(true));
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
  });
}

// Estado de carga reutilizable: HTML a insertar mientras se espera un fetch
// inicial, para no dejar la pantalla en blanco sin ningún indicio.
function loadingHTML(label) {
  const tr = typeof t === "function" ? t : (key, fallback) => (typeof fallback === "string" ? fallback : key);
  return `<div class="loading-state"><span class="spinner"></span><span>${label || tr("ui.loading", "Cargando...")}</span></div>`;
}

// Modal de emisión de factura, compartido entre pedidos.html (lista de
// pedidos) y pos.html (detalle de un pedido) para no mantener dos copias del
// mismo flujo. onSuccess se llama después de emitir con éxito, para que cada
// página refresque lo que corresponda (la lista o el pedido abierto).
function openIssueInvoiceModal(orderId, code, customerName, onSuccess) {
  const tr = typeof t === "function" ? t : (key, fallback) => (typeof fallback === "string" ? fallback : key);
  const overlay = showModal(`
    <h2>${tr("pedidos.issueModal.title", { code })}</h2>
    <p class="small muted">${tr("pedidos.issueModal.hint", "Se genera con el próximo número correlativo configurado en Administración → Parámetros.")}</p>
    <div class="field"><label>${tr("pedidos.issueModal.nameLabel", "Nombre / razón social del cliente")}</label><input id="inv-name" value="${customerName || ""}" /></div>
    <div class="field"><label>${tr("pedidos.issueModal.taxIdLabel", "NIT / identificación fiscal del cliente (opcional)")}</label><input id="inv-taxid" /></div>
    <div class="field"><label>${tr("pedidos.issueModal.emailLabel", "Email del cliente (opcional, para poder enviarla por mail)")}</label><input id="inv-email" type="email" /></div>
    <button class="btn btn-primary" id="confirm-issue-invoice">${tr("pedidos.issueModal.confirmBtn", "Emitir factura")}</button>
  `);
  overlay.querySelector("#confirm-issue-invoice").addEventListener("click", async () => {
    try {
      await api(`/orders/${orderId}/invoice`, {
        method: "POST",
        body: {
          customerName: overlay.querySelector("#inv-name").value || undefined,
          customerTaxId: overlay.querySelector("#inv-taxid").value || undefined,
          customerEmail: overlay.querySelector("#inv-email").value || undefined,
        },
      });
      closeModal(overlay);
      toast(tr("pedidos.issueSuccess", "Factura emitida."), "success");
      if (typeof onSuccess === "function") await onSuccess();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

function connectSocket() {
  if (typeof io === "undefined") return null;
  const socket = io({ transports: ["websocket", "polling"] });
  return socket;
}
