import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

export interface ParsedTabularData {
  headers: string[];
  rows: Record<string, string>[];
  suggestedPhoneColumn: string | null;
  suggestedTextColumn: string | null;
}

const PHONE_COLUMN_CANDIDATES = [
  'telefono',
  'teléfono',
  'phone',
  'celular',
  'cel',
  'whatsapp',
  'wsp',
  'numero',
  'número',
  'chatid',
  'chat_id',
  'destinatario',
  'movil',
  'móvil',
];

const TEXT_COLUMN_CANDIDATES = [
  'mensaje',
  'texto',
  'message',
  'text',
  'cuerpo',
  'body',
];

function detectCsvDelimiter(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  let bestDelimiter = ',';
  let bestCount = -1;

  for (const delim of candidates) {
    const count = firstLine.split(delim).length - 1;
    if (count > bestCount) {
      bestCount = count;
      bestDelimiter = delim;
    }
  }
  return bestDelimiter;
}

function normalizeHeaderName(raw: string, index: number): string {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  return trimmed || `columna_${index + 1}`;
}

function cellValueToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') {
      return value.text.trim();
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? '').join('').trim();
    }
    if ('result' in value && value.result !== undefined && value.result !== null) {
      return cellValueToString(value.result as ExcelJS.CellValue);
    }
    if ('hyperlink' in value && typeof value.hyperlink === 'string') {
      return value.hyperlink.trim();
    }
  }
  return String(value).trim();
}

function detectCandidateColumn(headers: string[], candidates: string[]): string | null {
  const lowerHeaders = headers.map((h) => ({ raw: h, lower: h.trim().toLowerCase() }));
  for (const candidate of candidates) {
    const exact = lowerHeaders.find((h) => h.lower === candidate);
    if (exact) return exact.raw;
  }
  for (const candidate of candidates) {
    const partial = lowerHeaders.find((h) => h.lower.includes(candidate));
    if (partial) return partial.raw;
  }
  return null;
}

function finalizeParsedData(headers: string[], rows: Record<string, string>[]): ParsedTabularData {
  const cleanRows = rows.filter((row) =>
    Object.values(row).some((val) => val.trim().length > 0)
  );
  return {
    headers,
    rows: cleanRows,
    suggestedPhoneColumn: detectCandidateColumn(headers, PHONE_COLUMN_CANDIDATES),
    suggestedTextColumn: detectCandidateColumn(headers, TEXT_COLUMN_CANDIDATES),
  };
}

export async function parseSpreadsheetBuffer(
  buffer: Buffer,
  filename: string
): Promise<ParsedTabularData> {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.xls') {
    throw new Error(
      'El formato legado .xls no es compatible directamente. Guarda la planilla como .xlsx o .csv e intenta nuevamente.'
    );
  }

  if (ext === '.csv' || ext === '.txt') {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) {
      throw new Error('El archivo CSV está vacío.');
    }
    const delimiter = detectCsvDelimiter(text);
    const records = parseCsv(text, {
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as string[][];

    if (records.length < 2) {
      throw new Error('El archivo CSV debe incluir fila de encabezados y al menos una fila de datos.');
    }

    const headers = records[0].map((h, i) => normalizeHeaderName(String(h ?? ''), i));
    const rows: Record<string, string>[] = [];
    for (let r = 1; r < records.length; r++) {
      const record = records[r];
      const obj: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = String(record[c] ?? '').trim();
      }
      rows.push(obj);
    }
    return finalizeParsedData(headers, rows);
  }

  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new Error('El archivo Excel no contiene hojas.');
    }

    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    const maxCols = Math.max(headerRow.cellCount, sheet.columnCount);
    for (let c = 1; c <= maxCols; c++) {
      const val = cellValueToString(headerRow.getCell(c).value);
      if (val || c <= headerRow.actualCellCount) {
        headers.push(normalizeHeaderName(val, c - 1));
      }
    }

    if (headers.length === 0) {
      throw new Error('No se encontraron encabezados en la primera fila del Excel.');
    }

    const rows: Record<string, string>[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj: Record<string, string> = {};
      for (let c = 1; c <= headers.length; c++) {
        obj[headers[c - 1]] = cellValueToString(row.getCell(c).value);
      }
      rows.push(obj);
    });

    if (rows.length === 0) {
      throw new Error('El archivo Excel no contiene filas de datos.');
    }

    return finalizeParsedData(headers, rows);
  }

  throw new Error(
    `Extensión no soportada (${ext || 'sin extensión'}). Usa archivos .xlsx o .csv.`
  );
}
