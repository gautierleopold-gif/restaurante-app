const XLSX = require("xlsx");

// Parsea un archivo .xls (formato binario viejo de Excel, el que exporta Fudo
// por defecto), .xlsx o .csv (recibido como base64 desde el frontend) y lo
// normaliza a una lista de "hojas" con encabezados + filas, para que el resto
// del importador no tenga que preocuparse por el formato de origen.
//
// Se usa SheetJS (paquete "xlsx") en vez de ExcelJS porque además del .xlsx
// moderno necesitamos poder leer el .xls binario viejo (formato BIFF/OLE2)
// que es el que efectivamente descarga Fudo al exportar productos — ExcelJS
// solo entiende .xlsx.

function sheetFromMatrix(name, matrix) {
  const headerRow = matrix[0] || [];
  const headers = headerRow.map((h) => String(h == null ? "" : h).trim());
  const rows = matrix.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      const raw = r[idx];
      obj[h] = raw == null ? "" : raw;
    });
    return obj;
  });
  return { name, headers: headers.filter(Boolean), rows, rowCount: rows.length };
}

async function parseWorkbookBase64(base64, fileName = "") {
  const buffer = Buffer.from(base64, "base64");

  let workbook;
  try {
    // raw:true evita que SheetJS formatee números/fechas como texto (por
    // ejemplo precios), así el resto del importador recibe los valores
    // numéricos ya limpios en vez de strings formateados según la config
    // regional de la planilla de origen.
    workbook = XLSX.read(buffer, { type: "buffer", raw: true, cellDates: false });
  } catch (err) {
    throw Object.assign(
      new Error("No se pudo leer el archivo. Verificá que sea un .xls, .xlsx o .csv válido."),
      { status: 400 }
    );
  }

  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: "", blankrows: false });
    if (!matrix || matrix.length === 0) continue;
    sheets.push(sheetFromMatrix(sheetName, matrix));
  }

  if (sheets.length === 0) {
    throw Object.assign(new Error("El archivo no tiene ninguna hoja con datos."), { status: 400 });
  }
  return { sheets };
}

module.exports = { parseWorkbookBase64 };
