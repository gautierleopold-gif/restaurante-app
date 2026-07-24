// Cliente HTTP simple para hablar con el backend. Guarda la sesión en
// localStorage (token JWT + datos del usuario) para mantener la sesión
// abierta entre recargas de página.

const API_BASE = "/api";

function getToken() {
  return localStorage.getItem("rg_token");
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem("rg_user"));
  } catch (e) {
    return null;
  }
}

function setSession(token, user) {
  localStorage.setItem("rg_token", token);
  localStorage.setItem("rg_user", JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem("rg_token");
  localStorage.removeItem("rg_user");
}

async function api(path, { method = "GET", body, headers } = {}) {
  const token = getToken();
  const finalHeaders = { "Content-Type": "application/json", ...(headers || {}) };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  const res = await fetch(API_BASE + path, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    clearSession();
    if (!location.pathname.endsWith("/index.html") && location.pathname !== "/") {
      location.href = "/index.html";
    }
    throw new Error("Sesión expirada. Iniciá sesión nuevamente.");
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
  }

  if (!res.ok) {
    const message = (data && data.error) || `Error ${res.status}`;
    const err = new Error(message);
    err.details = data && data.details;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Autorización de supervisor ("manager override"): cuando el usuario logueado
// no tiene permiso para una acción puntual (por ejemplo un Mozo anulando un
// ítem), en vez de fallar directo se le puede pedir a un Encargado/Dueño/Admin
// que la autorice ahí mismo con su email y contraseña, sin cerrar sesión.
// ---------------------------------------------------------------------------
function requestManagerOverride(permission) {
  return new Promise((resolve, reject) => {
    const overlay = showModal(`
      <h2>Autorización requerida</h2>
      <p class="small muted">Tu usuario no tiene permiso para esta acción. Un Encargado, Dueño o Administrador puede autorizarla ingresando su email y contraseña acá mismo.</p>
      <div class="field"><label>Email de quien autoriza</label><input id="ov-email" type="email" /></div>
      <div class="field"><label>Contraseña</label><input id="ov-password" type="password" /></div>
      <div class="flex-gap mt16">
        <button class="btn btn-primary" id="ov-confirm">Autorizar</button>
        <button class="btn" id="ov-cancel">Cancelar</button>
      </div>
    `);
    overlay.querySelector("#ov-cancel").addEventListener("click", () => {
      closeModal(overlay);
      reject(new Error("Autorización cancelada."));
    });
    overlay.querySelector("#ov-confirm").addEventListener("click", async () => {
      try {
        const email = overlay.querySelector("#ov-email").value;
        const password = overlay.querySelector("#ov-password").value;
        const data = await api("/auth/authorize-override", { method: "POST", body: { email, password, permission } });
        closeModal(overlay);
        toast(`Autorizado por ${data.managerName}.`, "success");
        resolve(data.overrideToken);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

// Envoltorio de api() para acciones que requieren un permiso puntual: si el
// usuario logueado no lo tiene (403), ofrece pedir autorización de un
// supervisor y reintenta automáticamente con el token de autorización.
async function apiWithOverride(path, opts, permission) {
  try {
    return await api(path, opts);
  } catch (err) {
    if (err.status === 403) {
      const overrideToken = await requestManagerOverride(permission);
      const headers = { ...((opts && opts.headers) || {}), "X-Override-Token": overrideToken };
      return await api(path, { ...opts, headers });
    }
    throw err;
  }
}

const money = (n) =>
  Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
