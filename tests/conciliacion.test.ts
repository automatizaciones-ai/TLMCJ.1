import { describe, expect, test } from 'bun:test';
import PDFDocument from 'pdfkit';
import { detectarBanco, interpretarLineasExtracto, leerExtractoPdf, lineasDesdePalabrasOcr, parsearMonto } from '../src/server/services/lectorArchivosContables.ts';

function crearPdf(celdas: { texto: string; x: number; y: number }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: [1000, 900] });
    const partes: Buffer[] = [];
    pdf.on('data', parte => partes.push(Buffer.from(parte)));
    pdf.on('end', () => resolve(Buffer.concat(partes)));
    pdf.on('error', reject);
    for (const celda of celdas) pdf.text(celda.texto, celda.x, celda.y);
    pdf.end();
  });
}

describe('lectura de extractos PDF', () => {
  test('lee saldos de resumen en filas separadas y conserva el signo del débito', async () => {
    const pdf = await crearPdf([
      { texto: 'BANCO CAJA SOCIAL', x: 50, y: 40 },
      { texto: 'PERIODO 2026', x: 50, y: 60 },
      { texto: 'SALDO ANTERIOR', x: 50, y: 100 },
      { texto: 'MÁS CRÉDITOS', x: 220, y: 100 },
      { texto: 'MENOS DÉBITOS', x: 390, y: 100 },
      { texto: 'INTERESES', x: 560, y: 100 },
      { texto: 'NUEVO SALDO', x: 700, y: 100 },
      { texto: '4.519.762,29', x: 50, y: 120 },
      { texto: '10,00', x: 220, y: 120 },
      { texto: '205,00', x: 390, y: 120 },
      { texto: '0,00', x: 560, y: 120 },
      { texto: '4.519.567,29', x: 700, y: 120 },
      { texto: '001', x: 50, y: 160 },
      { texto: '01  01', x: 90, y: 160 },
      { texto: 'PAGO SERVICIO', x: 180, y: 160 },
      { texto: '200,00', x: 380, y: 160 },
      { texto: '0,00', x: 470, y: 160 },
      { texto: '4.519.562,29', x: 550, y: 160 },
      { texto: 'DB', x: 720, y: 160 },
      { texto: '02  01', x: 50, y: 180 },
      { texto: 'INTERESES', x: 130, y: 180 },
      { texto: '10,00 CR', x: 380, y: 180 },
      { texto: '4.519.572,29', x: 550, y: 180 },
      { texto: '03  01', x: 50, y: 200 },
      { texto: 'COMISION', x: 130, y: 200 },
      { texto: '5,00 -', x: 380, y: 200 },
      { texto: '4.519.567,29', x: 550, y: 200 }
    ]);

    const lectura = await leerExtractoPdf(pdf, 'caja-social.pdf');

    expect(lectura.saldo_inicial).toBe(4_519_762.29);
    expect(lectura.saldo_final).toBe(4_519_567.29);
    expect(lectura.movimientos.map(m => m.valor)).toEqual([-200, 10, -5]);
    expect(lectura.saldos_consistentes).toBe(true);
  });

  test('interpreta el último punto como decimal cuando el OCR repite separadores de miles', () => {
    expect(parsearMonto('4.519.762.29')).toBe(4_519_762.29);
    expect(parsearMonto('4,519,762,29')).toBe(4_519_762.29);
  });

  test('normaliza importes OCR y deduce como débito el primer movimiento marcado como pago', () => {
    const lecturaOcr = interpretarLineasExtracto([
      'BBVA',
      'PERIODO 2026',
      '01/01/2026  CONSIGNACION  72,702,150,96  156,490,623,64'
    ], 'bbva.pdf', true);
    const lecturaDebito = interpretarLineasExtracto([
      'PERIODO 2026',
      '01/01/2026  PAGO SERVICIO  200,00  4.519.562,29'
    ], 'caja-social.pdf');

    expect(lecturaOcr.movimientos[0].valor).toBe(72_702_150.96);
    expect(lecturaOcr.saldo_inicial).toBe(83_788_472.68);
    expect(lecturaOcr.banco_detectado).toBe('BBVA');
    expect(lecturaDebito.saldo_inicial).toBe(4_519_762.29);
    expect(lecturaDebito.movimientos[0].valor).toBe(-200);
  });

  test('prioriza señales identificables del banco sobre nombres en descripciones', () => {
    expect(detectarBanco('BBVA Colombia · movimiento procesado en Banco Davivienda')).toBe('BBVA');
  });

  test('lee el formato Davivienda con día y mes separados y marcas +/- por importe', () => {
    const lectura = interpretarLineasExtracto([
      'INFORME DEL MES: JULIO /2026',
      'Saldo Anterior  $1,000.00  Días Sobregiro  0',
      'Nuevo Saldo  $1,100.00',
      '01  07  Pago proveedor  0000  $100.00-  $900.00+',
      '02  07  Consignación  0000  $200.00+  $1,100.00+'
    ], 'davivienda.pdf');

    expect(lectura.banco_detectado).toBe('DAVIVIENDA');
    expect(lectura.movimientos.map(m => m.fecha)).toEqual(['2026-07-01', '2026-07-02']);
    expect(lectura.movimientos.map(m => m.valor)).toEqual([-100, 200]);
    expect(lectura.saldo_inicial).toBe(1_000);
    expect(lectura.saldo_final).toBe(1_100);
    expect(lectura.saldos_consistentes).toBe(true);
  });

  test('reconstruye filas y separa columnas OCR según sus coordenadas', () => {
    const lineas = lineasDesdePalabrasOcr([
      { texto: '01/01/2026', x0: 10, y0: 10, x1: 90, y1: 30 },
      { texto: 'PAGO', x0: 98, y0: 10, x1: 140, y1: 30 },
      { texto: '200,00', x0: 300, y0: 10, x1: 360, y1: 30 },
      { texto: '02/01/2026', x0: 10, y0: 42, x1: 90, y1: 62 },
      { texto: 'ABONO', x0: 98, y0: 42, x1: 150, y1: 62 }
    ]);

    expect(lineas).toHaveLength(2);
    expect(lineas[0]).toBe('01/01/2026 PAGO  200,00');
    expect(lineas[1]).toBe('02/01/2026 ABONO');
  });
});
