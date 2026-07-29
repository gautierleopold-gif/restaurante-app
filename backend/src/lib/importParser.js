const ExcelJS = require("exceljs");

// Parsea un archivo .xlsx o .csv (recibido como base64 desde el frontend) y lo
// normaliza a una lista de "hojas" con encabezados + filas, para que el resto
// del importador no tenga que preocuparse por el formato de origen.
//
// Sirve tanto para exports de Fudo (que suelen venir en .xlsx, a veces con
// varias hojas) como de cualquier otro sistema que permita exportar a Excel o
// CSV (la mayoría de los POS de gestión de restaurantes lo permiten).

function parseCsv(text) {
  // Parser CSV manual (sin dependencias): soporta campos entre comillas con
  // comas y saltos de línea adentro, y comillas escapadas ("").
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\r") {
      i += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell || "").trim() !== ""));
}

function sheetFromMatrix(name, matrix) {
  const headerRow = matrix[0] || [];
  const headers = headerRow.map((h) => String(h == null ? "" : h).trim());
  const rows = matrix.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      const raw = r[idx];
      obj[h] = raw == null ? "" : typeof raw === "object" && raw.text ? raw.text : raw;
    });
    return obj;
  });
  return { name, headers: headers.filter(Boolean), rows, rowCount: rows.length };
}

async function parseWorkbookBase64(base64, fileName = "") {
  const buffer = Buffer.from(base64, "base64");
  const isCsv = /\.csv$/i.test(fileName) || (!/\.xlsx?$/i.test(fileName) && looksLikeCsv(buffer));

  if (isCsv) {
    const text = buffer.toString("utf8");
    const matrix = parseCsv(text);
    if (matrix.length === 0) {
      throw Object.assign(new Error("El archivo CSV está vacío o no se pudo leer."), { status: 400 });
    }
    return { sheets: [sheetFromMatrix("Hoja 1", matrix)] };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    throw Object.assign(
      new Error("No se pudo leer el archivo. Verificá que sea un .xlsx o .csv válido."),
      { status: 400 }
    );
  }

  const sheets = [];
  workbook.eachSheet((worksheet) => {
    const matrix = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values.slice(1); // ExcelJS antepone un índice vacío en la posición 0
      matrix.push(values.map((v) => (v && typeof v === "object" && "text" in v ? v.text : v)));
    });
    if (matrix.length === 0) return;
    sheets.push(sheetFromMatrix(worksheet.name, matrix));
  });

  if (sheets.length === 0) {
    throw Object.assign(new Error("El archivo no tiene ninguna hoja con datos."), { status: 400 });
  }
  return { sheets };
}

function looksLikeCsv(buffer) {
  // Heurística simple: si arranca con "PK" es un .xlsx (es un zip). Si no, y
  // tiene comas/saltos de línea en los primeros bytes, lo tratamos como CSV.
  const head = buffer.slice(0, 4).toString("utf8");
  if (buffer.slice(0, 2).toString("hex") === "504b") return false; // "PK"
  return true;
}

module.exports = { parseWorkbookBase64, parseCsv };
