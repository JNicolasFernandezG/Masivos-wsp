import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseSpreadsheetBuffer } from '../src/services/fileParser.js';

describe('fileParser', () => {
  it('parsea CSV con BOM UTF-8 y delimitador punto y coma', async () => {
    const csv = '\uFEFFtelefono;nombre;monto\r\n5491112345678;Ana;$ 1000\r\n5491187654321;Luis;$ 2000\r\n';
    const parsed = await parseSpreadsheetBuffer(Buffer.from(csv, 'utf8'), 'lote.csv');

    expect(parsed.headers).toEqual(['telefono', 'nombre', 'monto']);
    expect(parsed.suggestedPhoneColumn).toBe('telefono');
    expect(parsed.rows).toEqual([
      { telefono: '5491112345678', nombre: 'Ana', monto: '$ 1000' },
      { telefono: '5491187654321', nombre: 'Luis', monto: '$ 2000' },
    ]);
  });

  it('parsea archivos Excel .xlsx reales', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Contactos');
    sheet.addRow(['Celular', 'Nombre', 'Mensaje']);
    sheet.addRow(['5491122334455', 'María', 'Hola María, tu gestión está lista']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await parseSpreadsheetBuffer(buffer, 'contactos.xlsx');
    expect(parsed.headers).toEqual(['Celular', 'Nombre', 'Mensaje']);
    expect(parsed.suggestedPhoneColumn).toBe('Celular');
    expect(parsed.suggestedTextColumn).toBe('Mensaje');
    expect(parsed.rows).toEqual([
      {
        Celular: '5491122334455',
        Nombre: 'María',
        Mensaje: 'Hola María, tu gestión está lista',
      },
    ]);
  });

  it('rechaza formato legado .xls con mensaje claro', async () => {
    await expect(
      parseSpreadsheetBuffer(Buffer.from('dummy'), 'viejo.xls')
    ).rejects.toThrow(/\.xlsx o \.csv/);
  });
});
