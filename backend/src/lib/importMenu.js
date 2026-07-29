const { query } = require("../db/pool");

// Lógica de importación de menú (categorías, productos, variantes y grupos de
// adicionales) desde un archivo exportado de Fudo o de cualquier otro sistema
// de gestión de restaurante que permita exportar a Excel/CSV. No apuntamos a
// un único formato fijo: el usuario mapea, en el frontend, qué columna de su
// archivo corresponde a cada campo nuestro (con una sugerencia automática
// basada en los nombres de columna típicos, incluidos los que usa Fudo).

function normalizeHeader(h) {
  return String(h || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // saca tildes (marcas de acento tras la descomposición NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Definición de campos por tipo de importación: cada uno tiene una lista de
// sinónimos (normalizados) que se usan para adivinar el mapeo automáticamente
// a partir de los encabezados del archivo. Los nombres de Fudo (confirmados
// contra su Centro de Ayuda) están incluidos, junto con sinónimos genéricos.
const PRODUCT_FIELDS = [
  { key: "categoria", label: "Categoría", required: true, synonyms: ["categoria", "category", "rubro", "familia"] },
  { key: "subcategoria", label: "Sub-categoría", required: false, synonyms: ["sub categoria", "subcategoria", "subcategory"] },
  { key: "nombre", label: "Nombre", required: true, synonyms: ["nombre", "name", "producto", "item", "articulo"] },
  { key: "descripcion", label: "Descripción", required: false, synonyms: ["descripcion", "description"] },
  { key: "precio", label: "Precio", required: true, synonyms: ["precio", "price", "pvp", "precio de venta", "venta"] },
  { key: "costo", label: "Costo", required: false, synonyms: ["costo", "cost", "costo unitario"] },
  { key: "codigo", label: "Código", required: false, synonyms: ["codigo", "code", "sku"] },
  { key: "activo", label: "Activo (Si/No)", required: false, synonyms: ["activo", "active", "habilitado", "estado"] },
];

const VARIANT_FIELDS = [
  { key: "producto", label: "Producto", required: true, synonyms: ["producto", "product", "nombre", "item"] },
  { key: "variante", label: "Variante", required: true, synonyms: ["variante", "variant", "tamano", "opcion"] },
  { key: "precio", label: "Precio", required: true, synonyms: ["precio", "price"] },
];

const MODIFIER_FIELDS = [
  { key: "grupo", label: "Grupo", required: true, synonyms: ["grupo", "grupo modificador", "group"] },
  {
    key: "productoAsociado",
    label: "Producto(s) asociado(s)",
    required: false,
    synonyms: ["producto asociado", "productos asociados", "producto", "asociado a"],
  },
  { key: "opcion", label: "Opción", required: true, synonyms: ["opcion", "producto", "option", "item"] },
  { key: "precioOpcion", label: "Precio de la opción", required: false, synonyms: ["precio", "precio opcion", "price"] },
  { key: "minimo", label: "Mínimo", required: false, synonyms: ["cant minima", "minimo", "min"] },
  { key: "maximo", label: "Máximo", required: false, synonyms: ["cant maxima", "maximo", "max"] },
  { key: "obligatorio", label: "Obligatorio (Si/No)", required: false, synonyms: ["obligatorio", "required"] },
  {
    key: "repartoCantidades",
    label: "Reparto de cantidades (Si/No)",
    required: false,
    synonyms: ["reparto de cantidades", "reparto", "split"],
  },
];

function guessMapping(headers, fieldDefs) {
  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping = {};
  for (const field of fieldDefs) {
    const match = normalizedHeaders.find((h) => field.synonyms.includes(h.norm));
    mapping[field.key] = match ? match.raw : null;
  }
  return mapping;
}

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (["si", "sí", "yes", "true", "1", "x", "activo"].includes(v)) return true;
  if (["no", "false", "0", ""].includes(v)) return false;
  return defaultValue;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return value;
  let s = String(value).trim();
  // Soporta tanto "1234.56" como el formato "1.234,56" (miles con punto, decimales con coma).
  if (/,\d{1,2}$/.test(s) && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/,\d{1,2}$/.test(s)) {
    s = s.replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

async function findOrCreateCategory(name, cache) {
  const key = name.trim().toLowerCase();
  if (cache.has(key)) return { category: cache.get(key), created: false };
  const { rows: existing } = await query(`SELECT * FROM categories WHERE lower(name) = $1 LIMIT 1`, [key]);
  if (existing[0]) {
    cache.set(key, existing[0]);
    return { category: existing[0], created: false };
  }
  const { rows } = await query(`INSERT INTO categories (name) VALUES ($1) RETURNING *`, [name.trim()]);
  cache.set(key, rows[0]);
  return { category: rows[0], created: true };
}

async function importProductsRows(rows, mapping) {
  const summary = {
    totalRows: rows.length,
    categoriesCreated: 0,
    categoriesReused: 0,
    productsCreated: 0,
    productsUpdated: 0,
    rowErrors: [],
  };
  const categoryCache = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +1 por índice base 1, +1 por la fila de encabezados
    try {
      const rawCategoria = mapping.categoria ? row[mapping.categoria] : null;
      const rawSub = mapping.subcategoria ? row[mapping.subcategoria] : null;
      const rawNombre = mapping.nombre ? row[mapping.nombre] : null;
      const rawPrecio = mapping.precio ? row[mapping.precio] : null;

      if (!rawCategoria || !String(rawCategoria).trim()) {
        throw new Error("Falta la categoría.");
      }
      if (!rawNombre || !String(rawNombre).trim()) {
        throw new Error("Falta el nombre del producto.");
      }
      const precio = parseNumber(rawPrecio);
      if (precio === null || precio < 0) {
        throw new Error(`Precio inválido: "${rawPrecio}".`);
      }

      const categoryName = rawSub && String(rawSub).trim()
        ? `${String(rawCategoria).trim()} - ${String(rawSub).trim()}`
        : String(rawCategoria).trim();

      const { category, created } = await findOrCreateCategory(categoryName, categoryCache);
      if (created) summary.categoriesCreated += 1;
      else summary.categoriesReused += 1;

      const nombre = String(rawNombre).trim();
      const costo = mapping.costo ? parseNumber(row[mapping.costo]) : null;
      const codigo = mapping.codigo ? String(row[mapping.codigo] || "").trim() : "";
      let descripcion = mapping.descripcion ? String(row[mapping.descripcion] || "").trim() : "";
      if (codigo) descripcion = descripcion ? `${descripcion} (Código: ${codigo})` : `Código: ${codigo}`;
      const activo = mapping.activo ? parseBoolean(row[mapping.activo], true) : true;

      const { rows: existingProduct } = await query(
        `SELECT * FROM products WHERE category_id = $1 AND lower(name) = $2 LIMIT 1`,
        [category.id, nombre.toLowerCase()]
      );

      if (existingProduct[0]) {
        await query(
          `UPDATE products SET base_price = $1, description = COALESCE(NULLIF($2,''), description), active = $3 WHERE id = $4`,
          [precio, descripcion, activo, existingProduct[0].id]
        );
        summary.productsUpdated += 1;
      } else {
        await query(
          `INSERT INTO products (name, description, category_id, base_price, active) VALUES ($1,$2,$3,$4,$5)`,
          [nombre, descripcion || null, category.id, precio, activo]
        );
        summary.productsCreated += 1;
      }
      // costo no tiene columna dedicada en products; si en el futuro se agrega
      // costo por producto (hoy el costo vive en insumos/ingredientes), acá es
      // donde se guardaría.
      void costo;
    } catch (err) {
      summary.rowErrors.push({ row: rowNum, error: err.message });
    }
  }
  return summary;
}

async function importVariantsRows(rows, mapping) {
  const summary = { totalRows: rows.length, variantsCreated: 0, variantsUpdated: 0, rowErrors: [] };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    try {
      const productoNombre = mapping.producto ? String(row[mapping.producto] || "").trim() : "";
      const varianteNombre = mapping.variante ? String(row[mapping.variante] || "").trim() : "";
      const precio = parseNumber(mapping.precio ? row[mapping.precio] : null);
      if (!productoNombre) throw new Error("Falta el nombre del producto.");
      if (!varianteNombre) throw new Error("Falta el nombre de la variante.");
      if (precio === null || precio < 0) throw new Error(`Precio inválido: "${row[mapping.precio]}".`);

      const { rows: productRows } = await query(`SELECT * FROM products WHERE lower(name) = $1 LIMIT 1`, [
        productoNombre.toLowerCase(),
      ]);
      if (!productRows[0]) {
        throw new Error(`No se encontró el producto "${productoNombre}" (importalo primero en la sección de arriba).`);
      }
      const { rows: existingVariant } = await query(
        `SELECT * FROM product_variants WHERE product_id = $1 AND lower(name) = $2 LIMIT 1`,
        [productRows[0].id, varianteNombre.toLowerCase()]
      );
      if (existingVariant[0]) {
        await query(`UPDATE product_variants SET price = $1 WHERE id = $2`, [precio, existingVariant[0].id]);
        summary.variantsUpdated += 1;
      } else {
        await query(`INSERT INTO product_variants (product_id, name, price) VALUES ($1,$2,$3)`, [
          productRows[0].id,
          varianteNombre,
          precio,
        ]);
        summary.variantsCreated += 1;
      }
    } catch (err) {
      summary.rowErrors.push({ row: rowNum, error: err.message });
    }
  }
  return summary;
}

async function importModifierGroupsRows(rows, mapping) {
  const summary = {
    totalRows: rows.length,
    groupsCreated: 0,
    groupsReused: 0,
    optionsCreated: 0,
    optionsUpdated: 0,
    associationsCreated: 0,
    rowErrors: [],
  };
  const groupCache = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    try {
      const grupoNombre = mapping.grupo ? String(row[mapping.grupo] || "").trim() : "";
      const opcionNombre = mapping.opcion ? String(row[mapping.opcion] || "").trim() : "";
      if (!grupoNombre) throw new Error("Falta el nombre del grupo.");
      if (!opcionNombre) throw new Error("Falta el nombre de la opción.");

      const precioOpcion = mapping.precioOpcion ? parseNumber(row[mapping.precioOpcion]) : 0;
      const minimo = mapping.minimo ? parseNumber(row[mapping.minimo]) : 0;
      const maximo = mapping.maximo ? parseNumber(row[mapping.maximo]) : 1;
      const obligatorio = mapping.obligatorio ? parseBoolean(row[mapping.obligatorio], false) : false;
      const repartoCantidades = mapping.repartoCantidades ? parseBoolean(row[mapping.repartoCantidades], false) : false;

      const groupKey = grupoNombre.toLowerCase();
      let group = groupCache.get(groupKey);
      if (!group) {
        const { rows: existingGroup } = await query(`SELECT * FROM modifier_groups WHERE lower(name) = $1 LIMIT 1`, [
          groupKey,
        ]);
        if (existingGroup[0]) {
          group = existingGroup[0];
          summary.groupsReused += 1;
        } else {
          const { rows: createdGroup } = await query(
            `INSERT INTO modifier_groups (name, min, max, required, split_mode) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [grupoNombre, minimo || 0, maximo || 1, obligatorio, repartoCantidades]
          );
          group = createdGroup[0];
          summary.groupsCreated += 1;
        }
        groupCache.set(groupKey, group);
      }

      const { rows: existingModifier } = await query(
        `SELECT * FROM modifiers WHERE group_id = $1 AND lower(name) = $2 LIMIT 1`,
        [group.id, opcionNombre.toLowerCase()]
      );
      if (existingModifier[0]) {
        await query(`UPDATE modifiers SET price = $1 WHERE id = $2`, [precioOpcion || 0, existingModifier[0].id]);
        summary.optionsUpdated += 1;
      } else {
        await query(`INSERT INTO modifiers (group_id, name, price) VALUES ($1,$2,$3)`, [
          group.id,
          opcionNombre,
          precioOpcion || 0,
        ]);
        summary.optionsCreated += 1;
      }

      const asociadosRaw = mapping.productoAsociado ? String(row[mapping.productoAsociado] || "").trim() : "";
      if (asociadosRaw) {
        const nombres = asociadosRaw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        for (const nombreProducto of nombres) {
          const { rows: productRows } = await query(`SELECT * FROM products WHERE lower(name) = $1 LIMIT 1`, [
            nombreProducto.toLowerCase(),
          ]);
          if (!productRows[0]) {
            summary.rowErrors.push({
              row: rowNum,
              error: `No se encontró el producto "${nombreProducto}" para asociar el grupo "${grupoNombre}".`,
            });
            continue;
          }
          const { rowCount } = await query(
            `INSERT INTO product_modifier_groups (product_id, modifier_group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [productRows[0].id, group.id]
          );
          if (rowCount > 0) summary.associationsCreated += 1;
        }
      }
    } catch (err) {
      summary.rowErrors.push({ row: rowNum, error: err.message });
    }
  }
  return summary;
}

module.exports = {
  PRODUCT_FIELDS,
  VARIANT_FIELDS,
  MODIFIER_FIELDS,
  guessMapping,
  importProductsRows,
  importVariantsRows,
  importModifierGroupsRows,
};
