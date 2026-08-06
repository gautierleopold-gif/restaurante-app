// Internacionalización de la interfaz del staff: español, francés, inglés,
// portugués e italiano. El idioma se guarda por sucursal (Administración →
// Parámetros) y se aplica a toda la interfaz del personal.
//
// Alcance: se traduce la navegación, los títulos/pestañas principales de
// cada pantalla y los botones/acciones de uso más frecuente (Guardar,
// Cancelar, Editar, etc.). Los datos del negocio (nombres de productos,
// categorías, mesas, motivos escritos a mano) y los mensajes que devuelve el
// servidor (validaciones, errores) siguen en español, porque son contenido
// que cada restaurante carga con sus propias palabras, no texto fijo de la
// interfaz — traducirlos requeriría traducir automáticamente datos del
// usuario, lo que no es parte de esta entrega.

// A partir de la división por idioma (frontend/js/i18n/{es,fr,en,pt,it}.js),
// esta parte del archivo decide qué diccionario(s) cargar y expone las
// mismas funciones de siempre (t, setLang, applyTranslations, etc.) para que
// el resto de la app no note el cambio. Antes se cargaban los 5 idiomas
// completos (171 KB) en cada página aunque cada sucursal use uno solo; ahora
// se carga como máximo el idioma activo más español de respaldo (para que
// t() pueda caer a una traducción en español si a algún idioma le faltara
// una clave nueva).
const I18N_SUPPORTED_LANGS = ["es", "fr", "en", "pt", "it"];
const I18N_VARNAME = { es: "I18N_ES", fr: "I18N_FR", en: "I18N_EN", pt: "I18N_PT", it: "I18N_IT" };

let currentLang = localStorage.getItem("rg_lang") || "es";
if (!I18N_SUPPORTED_LANGS.includes(currentLang)) currentLang = "es";

// Español siempre se carga (es el respaldo); si el idioma activo es otro,
// se suma su propio script. document.write() acá es intencional: al
// ejecutarse mientras el parser todavía está procesando esta misma etiqueta
// <script src="/js/i18n.js">, inserta y corre el/los script(s) del
// diccionario de forma síncrona ANTES de que se sigan cargando los scripts
// siguientes (ui.js y el <script> propio de cada página), que ya llaman a
// t() apenas arrancan.
document.write('<script src="/js/i18n/es.js"><' + '/script>');
if (currentLang !== "es") {
  document.write('<script src="/js/i18n/' + currentLang + '.js"><' + '/script>');
}

// Qué idiomas quedaron efectivamente cargados en esta página (como máximo 2:
// español + el activo). Si más adelante hace falta cambiar a un tercer
// idioma sin haberlo cargado, setLang() recarga la página en vez de
// aplicar un diccionario a medias.
const I18N_LOADED = { es: true };
I18N_LOADED[currentLang] = true;

function activeDict() {
  return window[I18N_VARNAME[currentLang]] || window.I18N_ES;
}


const I18N_LANGUAGE_NAMES = { es: "Español", fr: "Français", en: "English", pt: "Português", it: "Italiano" };

// Locale usado para formatear fechas y números según el idioma elegido (no
// necesariamente el país real del restaurante: es simplemente la convención
// de formato asociada a cada idioma admitido).
const I18N_LOCALE_MAP = { es: "es-AR", fr: "fr-FR", en: "en-US", pt: "pt-BR", it: "it-IT" };

// Símbolo de moneda configurado en Administración → Parámetros (antes era
// un "$" fijo en el código). Se cachea igual que el idioma: se aplica de
// entrada con lo cacheado y se sincroniza contra el servidor en
// syncLangFromServer(), para no tener que esperar la red antes de poder
// mostrar cualquier monto.
let currencySymbol = localStorage.getItem("rg_currency_symbol") || "$";

function getCurrencySymbol() {
  return currencySymbol;
}

function setCurrencySymbol(symbol) {
  currencySymbol = symbol || "$";
  localStorage.setItem("rg_currency_symbol", currencySymbol);
}

// El segundo argumento puede ser:
// - un string: el texto de respaldo si la clave no existe (uso de siempre), o
// - un objeto: valores para reemplazar placeholders {nombre} dentro de la
//   traducción (ej. t("admin.salon.selectedCountSuffix", {count: 3})).
// Ambos usos conviven porque el código existente pasa strings como respaldo.
function t(key, fallbackOrParams) {
  const dict = activeDict();
  const isParams = fallbackOrParams !== null && typeof fallbackOrParams === "object";
  const fallback = isParams ? undefined : fallbackOrParams;
  let str = dict[key] || (window.I18N_ES && window.I18N_ES[key]) || fallback || key;
  if (isParams) {
    Object.keys(fallbackOrParams).forEach((paramKey) => {
      str = str.split(`{${paramKey}}`).join(fallbackOrParams[paramKey]);
    });
  }
  return str;
}

function getLang() {
  return currentLang;
}

// Formatea una fecha/hora respetando el idioma elegido en vez de un locale
// fijo. `opts` son las mismas opciones que acepta Intl (Date.toLocaleString).
function fmtDateTime(date, opts) {
  return new Date(date).toLocaleString(I18N_LOCALE_MAP[currentLang] || "es-AR", opts);
}

// Formatea un número (incluye montos de dinero) respetando el idioma elegido.
function fmtNumber(n, opts) {
  return Number(n || 0).toLocaleString(I18N_LOCALE_MAP[currentLang] || "es-AR", opts);
}

function setLang(lang) {
  const next = I18N_SUPPORTED_LANGS.includes(lang) ? lang : "es";
  if (next === currentLang) return;
  localStorage.setItem("rg_lang", next);
  if (!I18N_LOADED[next]) {
    // Esta página solo cargó español + el idioma con el que arrancó; para
    // no aplicar una traducción a medias, recargamos (mismo comportamiento
    // que ya usa el cambio de idioma interactivo en Administración →
    // Parámetros, que recarga la página después de llamar a setLang()).
    location.reload();
    return;
  }
  currentLang = next;
  applyTranslations();
}

// Traduce todos los elementos con data-i18n / data-i18n-placeholder dentro
// de `root` (por defecto, toda la página). Se puede volver a llamar después
// de re-renderizar una sección dinámica (por ejemplo, las pestañas de
// Administración) para que el contenido nuevo también quede traducido.
function applyTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n, el.textContent);
  });
  scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder, el.placeholder);
  });
}

// Sincroniza el idioma desde la configuración de la sucursal (fuente de
// verdad compartida por todo el personal) y lo cachea en localStorage para
// que la próxima carga de página lo aplique de inmediato, sin esperar esta
// llamada de red.
async function syncLangFromServer() {
  try {
    const res = await fetch("/api/settings/public", {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.branch && data.branch.language && data.branch.language !== currentLang) {
      setLang(data.branch.language);
    }
    if (data.branch && data.branch.currencySymbol && data.branch.currencySymbol !== currencySymbol) {
      setCurrencySymbol(data.branch.currencySymbol);
    }
  } catch (e) {
    // Sin conexión o sin sesión todavía: se queda con el idioma cacheado.
  }
}

// Traduce un nodo recién agregado al DOM (y sus hijos). A diferencia de
// applyTranslations(), también revisa el nodo raíz por si el propio nodo
// (no solo sus descendientes) tiene data-i18n.
function translateNode(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.hasAttribute && node.hasAttribute("data-i18n")) {
    node.textContent = t(node.dataset.i18n, node.textContent);
  }
  if (node.hasAttribute && node.hasAttribute("data-i18n-placeholder")) {
    node.placeholder = t(node.dataset.i18nPlaceholder, node.placeholder);
  }
  applyTranslations(node);
}

// Muchas pantallas re-renderizan secciones enteras con innerHTML (pestañas
// de Administración, tickets, modales) después de la carga inicial de la
// página. Sin esto, ese contenido nuevo se quedaría en español para
// siempre, porque applyTranslations() ya pasó una sola vez. Este observer
// traduce automáticamente cualquier nodo con data-i18n que se agregue al
// DOM en cualquier momento, para no depender de que cada función de render
// se acuerde de volver a llamar a applyTranslations() a mano.
if (typeof MutationObserver !== "undefined") {
  const i18nObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => translateNode(node));
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body) {
      i18nObserver.observe(document.body, { childList: true, subtree: true });
    }
  });
}

// Aplica el idioma cacheado apenas carga el script (antes de esperar la red)
// para que no haya un "flash" en español, y de paso sincroniza contra el
// servidor por si cambió desde otro dispositivo/usuario.
document.addEventListener("DOMContentLoaded", () => {
  applyTranslations();
  syncLangFromServer();
});
