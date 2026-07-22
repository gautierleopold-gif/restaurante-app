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
    throw err;
  }
  return data;
}

const money = (n) =>
  Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
