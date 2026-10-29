/**
 * Lectura tolerante de archivos contables con columnas variables:
 *  - Auxiliar de cuenta exportado de Siigo (.xlsx / .xls / .csv)
 *  - Extractos bancarios (.xlsx / .csv / .txt / .pdf)
 *  - Catálogo PUC y balance de prueba (.xlsx / .csv)
 *
 * La detección de columnas se hace por palabras clave del encabezado ("modelo agnóstico"),
 * de modo que sirven exportes de distintos ERP y bancos sin plantillas fijas.
 */
import * as XLSX from 'xlsx';

export interface MovimientoNormalizado {
  id: string;
  fecha: string; // AAAA-MM-DD
  descripcion: string;
  comprobante?: string;
  tercero?: string;
  referencia?: string;
  /** Valor con signo desde el punto de vista de la cuenta bancaria: + entra dinero, − sale dinero */
  valor: number;
  saldo?: number;
}

export interface LecturaMovimientos {
  movimientos: MovimientoNormalizado[];
  saldo_inicial: number;
  saldo_final: number;
  neto: number;
  banco_detectado?: string;
  advertencias: string[];
  /** true si saldo_inicial + neto = saldo_final (con tolerancia de $1) */
  saldos_consistentes: boolean;
}

// ==========================================
// Números y fechas
// ==========================================
export function parsearMonto(entrada: unknown): number {
  if (typeof entrada === 'number') return Number.isFinite(entrada) ? entrada : 0;
  let t = String(entrada ?? '').trim();
  if (!t) return 0;
  let negativo = false;
  if (/^\(.*\)$/.test(t)) { negativo = true; t = t.slice(1, -1); }
  if (/-\s*$/.test(t)) { negativo = true; t = t.replace(/-\s*$/, ''); }
  if (/^\s*-/.test(t) || /^\s*\$\s*-/.test(t)) negativo = true;
  t = t.replace(/[^\d.,]/g, '');
  if (!t) return 0;
  const ultimoPunto = t.lastIndexOf('.');
  const ultimaComa = t.lastIndexOf(',');
  if (ultimoPunto >= 0 && ultimaComa >= 0) {
    if (ultimaComa > ultimoPunto) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
  } else if (ultimaComa >= 0) {
    const decimales = t.length - ultimaComa - 1;
    t = (t.split(',').length === 2 && decimales > 0 && decimales <= 2) ? t.replace(',', '.') : t.replace(/,/g, '');
  } else if (ultimoPunto >= 0) {
    const partes = t.split('.');
    const decimales = t.length - ultimoPunto - 1;
    if (partes.length > 2 || decimales === 3) t = t.replace(/\./g, '');
  }
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return 0;
  return negativo ? -n : n;
}

const MESES: Record<string, number> = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8,
  sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12
};

const dosDigitos = (n: number) => String(n).padStart(2, '0');

export function parsearFecha(entrada: unknown, anioPorDefecto?: number): string {
  if (entrada === null || entrada === undefined || entrada === '') return '';
  if (entrada instanceof Date && !isNaN(entrada.getTime())) {
    return `${entrada.getFullYear()}-${dosDigitos(entrada.getMonth() + 1)}-${dosDigitos(entrada.getDate())}`;
  }
  if (typeof entrada === 'number' && entrada > 20000 && entrada < 80000) {
    const d = XLSX.SSF.parse_date_code(entrada);
    if (d) return `${d.y}-${dosDigitos(d.m)}-${dosDigitos(d.d)}`;
  }
  const t = String(entrada).trim().toLowerCase();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${dosDigitos(+m[2])}-${dosDigitos(+m[3])}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const anio = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return `${anio}-${dosDigitos(+m[2])}-${dosDigitos(+m[1])}`;
  }
  m = t.match(/^(\d{1,2})[-/\s]([a-zé]{3})[a-zé]*[-/\s,]*(\d{2,4})?/);
  if (m && MESES[m[2]]) {
    const anio = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : (anioPorDefecto || new Date().getFullYear());
    return `${anio}-${dosDigitos(MESES[m[2]])}-${dosDigitos(+m[1])}`;
  }
  m = t.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${anioPorDefecto || new Date().getFullYear()}-${dosDigitos(+m[2])}-${dosDigitos(+m[1])}`;
  return '';
}

const normalizarTexto = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ==========================================
// Hojas de cálculo → filas
// ==========================================
/** Todas las hojas del libro (o la única "hoja" de un CSV), de la más larga a la más corta */
export function leerHojas(buffer: Buffer, nombreArchivo: string): unknown[][][] {
  const lower = nombreArchivo.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return [leerFilas(buffer, nombreArchivo)];
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return wb.SheetNames.map(n => { corregirRango(wb.Sheets[n]); return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: true, defval: '' }); })
    .sort((a, b) => b.length - a.length);
}

export function leerFilas(buffer: Buffer, nombreArchivo: string): unknown[][] {
  const lower = nombreArchivo.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    let texto = buffer.toString('utf-8');
    if (texto.includes('�')) texto = buffer.toString('latin1');
    const lineas = texto.split(/\r?\n/).filter(l => l.trim());
    const sep = [';', '\t', '|', ','].map(s => ({ s, n: (lineas[0] || '').split(s).length })).sort((a, b) => b.n - a.n)[0].s;
    return lineas.map(l => l.split(sep).map(c => c.replace(/^"|"$/g, '').trim()));
  }
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  // Se toma la hoja con más filas útiles
  let mejor: unknown[][] = [];
  for (const nombre of wb.SheetNames) {
    const hoja = wb.Sheets[nombre];
    corregirRango(hoja);
    const filas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true, defval: '' });
    if (filas.length > mejor.length) mejor = filas;
  }
  return mejor;
}

/**
 * Siigo y otros ERP exportan hojas con la dimensión mal declarada (p. ej. A1:A31 aunque haya 16 columnas),
 * lo que hace que solo se lea la primera columna. Se recalcula el rango real a partir de las celdas.
 */
function corregirRango(hoja: XLSX.WorkSheet) {
  let maxF = -1, maxC = -1, minF = Infinity, minC = Infinity;
  for (const clave of Object.keys(hoja)) {
    if (clave.startsWith('!')) continue;
    const { r, c } = XLSX.utils.decode_cell(clave);
    if (r > maxF) maxF = r; if (c > maxC) maxC = c;
    if (r < minF) minF = r; if (c < minC) minC = c;
  }
  if (maxF < 0) return;
  hoja['!ref'] = XLSX.utils.encode_range({ s: { r: Math.min(minF, 0), c: Math.min(minC, 0) }, e: { r: maxF, c: maxC } });
}

interface MapaColumnas { [campo: string]: number }

function detectarEncabezado(filas: unknown[][], reglas: Record<string, RegExp>, obligatorios: string[], maxFilas = 40): { fila: number; mapa: MapaColumnas } | null {
  for (let i = 0; i < Math.min(filas.length, maxFilas); i++) {
    const celdas = (filas[i] || []).map(normalizarTexto);
    const mapa: MapaColumnas = {};
    for (const [campo, re] of Object.entries(reglas)) {
      const idx = celdas.findIndex((c, j) => re.test(c) && !Object.values(mapa).includes(j));
      if (idx >= 0) mapa[campo] = idx;
    }
    if (obligatorios.every(o => o.split('|').some(alt => mapa[alt] !== undefined))) return { fila: i, mapa };
  }
  return null;
}

function calcularResumen(movs: MovimientoNormalizado[], saldoInicial: number | null, saldoFinalLeido: number | null, advertencias: string[]): LecturaMovimientos {
  const neto = Math.round(movs.reduce((s, m) => s + m.valor, 0) * 100) / 100;
  let inicial = saldoInicial;
  if (inicial === null) {
    const primero = movs.find(m => m.saldo !== undefined);
    inicial = primero && primero.saldo !== undefined ? primero.saldo - primero.valor : 0;
  }
  const final = saldoFinalLeido ?? [...movs].reverse().find(m => m.saldo !== undefined)?.saldo ?? inicial + neto;
  const consistentes = Math.abs(inicial + neto - final) <= 1;
  if (!consistentes) {
    advertencias.push(`Los saldos no cuadran: inicial ${inicial.toFixed(2)} + neto ${neto.toFixed(2)} ≠ final ${final.toFixed(2)}. Revise el archivo o la lectura de signos.`);
  }
  return {
    movimientos: movs,
    saldo_inicial: Math.round(inicial * 100) / 100,
    saldo_final: Math.round(final * 100) / 100,
    neto,
    advertencias,
    saldos_consistentes: consistentes
  };
}

// ==========================================
// Auxiliar contable (libros)
// ==========================================
const REGLAS_AUXILIAR: Record<string, RegExp> = {
  fecha: /^fecha( de)?( elaboracion| documento| movimiento)?$|^fecha/,
  comprobante: /comprobante|documento|^doc|tipo y numero|^numero/,
  consecutivo: /consecutivo/,
  descripcion: /descripcion|detalle|concepto|observacion/,
  tercero: /nombre( del)? tercero|^tercero|razon social|^nombre/,
  nit: /identificacion|nit|cedula/,
  debito: /^debito|^debitos|^debe|^valor debito/,
  credito: /^credito|^creditos|^haber|^valor credito/,
  saldo: /^saldo( final)?$|saldo movimiento|^nuevo saldo/,
  saldo_inicial_col: /^saldo inicial|^saldo anterior/,
  saldo_total_col: /saldo total|^saldo final cuenta|^total cuenta/
};

export function leerAuxiliar(buffer: Buffer, nombreArchivo: string): LecturaMovimientos {
  const advertencias: string[] = [];
  let filas: unknown[][] = [];
  let enc: { fila: number; mapa: MapaColumnas } | null = null;
  const hojas = leerHojas(buffer, nombreArchivo);
  for (const h of hojas) {
    enc = detectarEncabezado(h, REGLAS_AUXILIAR, ['fecha', 'debito', 'credito']);
    if (enc) { filas = h; break; }
  }
  if (!enc) {
    const texto = normalizarTexto(hojas.flat(2).slice(0, 400).join(' '));
    if (/conciliacion|faltan en (libros|banco)|partidas conciliadas/.test(texto)) {
      throw new Error('Este archivo es un reporte de conciliación, no el auxiliar contable. Cargue el "Movimiento auxiliar por cuenta contable" exportado de Siigo (columnas Fecha, Débito y Crédito).');
    }
    throw new Error('No se encontró el encabezado del auxiliar (se esperan columnas Fecha, Débito y Crédito). Exporte desde Siigo el "Movimiento auxiliar por cuenta contable" en Excel.');
  }

  const { fila, mapa } = enc;
  const movs: MovimientoNormalizado[] = [];
  let saldoInicial: number | null = null;
  let saldoFinal: number | null = null;
  let cuentasResumen = 0;

  for (let i = fila + 1; i < filas.length; i++) {
    const r = filas[i] || [];
    const textoFila = normalizarTexto(r.join(' '));
    const fecha = parsearFecha(r[mapa.fecha]);
    if (!fecha) {
      // Fila resumen de cuenta de Siigo ("Cuenta contable: 11200503 ...") con columnas Saldo inicial / Saldo total cuenta
      if (/cuenta contable:|^total/.test(textoFila) && (mapa.saldo_inicial_col !== undefined || mapa.saldo_total_col !== undefined)) {
        if (/cuenta contable:/.test(textoFila)) cuentasResumen++;
        if (saldoInicial === null && mapa.saldo_inicial_col !== undefined && String(r[mapa.saldo_inicial_col] ?? '').trim() !== '') saldoInicial = parsearMonto(r[mapa.saldo_inicial_col]);
        if (saldoFinal === null && mapa.saldo_total_col !== undefined && String(r[mapa.saldo_total_col] ?? '').trim() !== '') saldoFinal = parsearMonto(r[mapa.saldo_total_col]);
        continue;
      }
      if (/saldo (inicial|anterior)/.test(textoFila) && saldoInicial === null) {
        const numeros = r.map(parsearMonto).filter(n => n !== 0);
        saldoInicial = mapa.saldo !== undefined && parsearMonto(r[mapa.saldo]) !== 0 ? parsearMonto(r[mapa.saldo]) : (numeros.at(-1) ?? 0);
      } else if (/saldo final|total cuenta|total general/.test(textoFila)) {
        if (mapa.saldo !== undefined && parsearMonto(r[mapa.saldo]) !== 0) saldoFinal = parsearMonto(r[mapa.saldo]);
      }
      continue;
    }
    const debito = parsearMonto(r[mapa.debito]);
    const credito = parsearMonto(r[mapa.credito]);
    if (debito === 0 && credito === 0) continue;
    const comprobante = [mapa.comprobante !== undefined ? String(r[mapa.comprobante] ?? '').trim() : '', mapa.consecutivo !== undefined ? String(r[mapa.consecutivo] ?? '').trim() : '']
      .filter(Boolean).join('-');
    movs.push({
      id: `LIB-${i}`,
      fecha,
      comprobante: comprobante || undefined,
      descripcion: String(r[mapa.descripcion] ?? r[mapa.tercero] ?? '').trim(),
      tercero: mapa.tercero !== undefined ? String(r[mapa.tercero] ?? '').trim() || undefined : undefined,
      valor: Math.round((debito - credito) * 100) / 100,
      saldo: mapa.saldo !== undefined && String(r[mapa.saldo] ?? '').trim() !== '' ? parsearMonto(r[mapa.saldo]) : undefined
    });
  }
  if (movs.length === 0) advertencias.push('El auxiliar no tiene movimientos con fecha.');
  if (cuentasResumen > 1) advertencias.push(`El auxiliar trae ${cuentasResumen} cuentas contables; exporte solo la cuenta del banco que va a conciliar.`);
  return calcularResumen(movs, saldoInicial, saldoFinal, advertencias);
}

// ==========================================
// Extracto bancario
// ==========================================
const BANCOS: [RegExp, string][] = [
  [/global ?66/i, 'GLOBAL66'],
  [/davivienda|daviplata/i, 'DAVIVIENDA'],
  [/bancolombia/i, 'BANCOLOMBIA'],
  [/bbva/i, 'BBVA'],
  [/banco de bogot|bancodebogota/i, 'BANCO DE BOGOTÁ'],
  [/occidente/i, 'BANCO DE OCCIDENTE'],
  [/popular/i, 'BANCO POPULAR'],
  [/av villas|avvillas/i, 'AV VILLAS'],
  [/colpatria|scotiabank/i, 'SCOTIABANK COLPATRIA'],
  [/caja social/i, 'BANCO CAJA SOCIAL'],
  [/itau|itaú/i, 'ITAÚ'],
  [/nequi/i, 'NEQUI'],
  [/banco agrario|bancoagrario/i, 'BANCO AGRARIO'],
  [/bancoomeva/i, 'BANCOOMEVA'],
  [/falabella/i, 'BANCO FALABELLA'],
  [/pichincha/i, 'BANCO PICHINCHA'],
  [/serfinanza/i, 'BANCO SERFINANZA'],
  [/gnb sudameris|sudameris/i, 'GNB SUDAMERIS'],
  [/lulo bank/i, 'LULO BANK'],
  [/confiar/i, 'CONFIAR'],
  [/coltefinanciera/i, 'COLTEFINANCIERA']
];

/**
 * Banco del extracto: el que aparece primero en el encabezado del documento.
 * (Los movimientos suelen nombrar otros bancos, p. ej. "PAGO PSE Banco Davivienda" en un extracto de Bancolombia.)
 */
export function detectarBanco(texto: string): string | undefined {
  let mejor: { pos: number; banco: string } | null = null;
  for (const [re, banco] of BANCOS) {
    const m = re.exec(texto);
    if (m && (mejor === null || m.index < mejor.pos)) mejor = { pos: m.index, banco };
  }
  return mejor?.banco;
}

const PALABRAS_SALIDA = /retiro|pago|cargo|debito|descuento|gravamen|4x1000|gmf|comision|compra|cobro|cuota|transferencia enviada|traslado a|nota debito|iva |impuesto|cheque pagado/;

export function leerExtractoTabla(buffer: Buffer, nombreArchivo: string): LecturaMovimientos {
  const filas = leerFilas(buffer, nombreArchivo);
  const advertencias: string[] = [];
  const enc = detectarEncabezado(
    filas,
    {
      fecha: /^fecha/,
      descripcion: /descripcion|concepto|detalle|transaccion|movimiento/,
      referencia: /referencia|documento|^doc|oficina/,
      valor: /^valor|^monto|^importe/,
      debito: /^debito|^debitos|retiro|cargo|egreso|salida/,
      credito: /^credito|^creditos|deposito|abono|ingreso|entrada|consignacion/,
      saldo: /^saldo/
    },
    ['fecha', 'valor|debito|credito']
  );
  if (!enc) throw new Error('No se encontró el encabezado del extracto (se espera una columna Fecha y Valor, o Débito/Crédito).');
  const { fila, mapa } = enc;
  const movs: MovimientoNormalizado[] = [];
  let saldoInicial: number | null = null;
  const anio = Number((filas.flat().map(String).join(' ').match(/20\d{2}/) || [])[0]) || undefined;

  for (let i = fila + 1; i < filas.length; i++) {
    const r = filas[i] || [];
    const texto = normalizarTexto(r.join(' '));
    const fecha = parsearFecha(r[mapa.fecha], anio);
    if (!fecha) {
      if (/saldo (inicial|anterior)/.test(texto) && saldoInicial === null) {
        const nums = r.map(parsearMonto).filter(n => n !== 0);
        if (nums.length) saldoInicial = nums.at(-1)!;
      }
      continue;
    }
    const descripcion = String(r[mapa.descripcion] ?? '').trim();
    let valor = 0;
    if (mapa.debito !== undefined || mapa.credito !== undefined) {
      const deb = Math.abs(parsearMonto(r[mapa.debito]));
      const cre = Math.abs(parsearMonto(r[mapa.credito]));
      valor = cre - deb;
      if (valor === 0 && mapa.valor !== undefined) valor = parsearMonto(r[mapa.valor]);
    } else {
      valor = parsearMonto(r[mapa.valor]);
    }
    if (valor === 0) continue;
    movs.push({
      id: `EXT-${i}`,
      fecha,
      descripcion,
      referencia: mapa.referencia !== undefined ? String(r[mapa.referencia] ?? '').trim() || undefined : undefined,
      valor,
      saldo: mapa.saldo !== undefined && String(r[mapa.saldo] ?? '').trim() !== '' ? parsearMonto(r[mapa.saldo]) : undefined
    });
  }

  // Si la columna de valor no trae signo, se infiere con el saldo o con palabras clave
  if (mapa.valor !== undefined && mapa.debito === undefined && mapa.credito === undefined && movs.every(m => m.valor > 0)) {
    inferirSignos(movs, saldoInicial);
  }
  const resultado = calcularResumen(movs, saldoInicial, null, advertencias);
  resultado.banco_detectado = detectarBanco(filas.slice(0, 15).flat().map(String).join(' ') + ' ' + nombreArchivo);
  return resultado;
}

function inferirSignos(movs: MovimientoNormalizado[], saldoInicial: number | null) {
  let anterior = saldoInicial;
  for (const m of movs) {
    const abs = Math.abs(m.valor);
    if (anterior !== null && m.saldo !== undefined) {
      if (Math.abs(anterior + abs - m.saldo) < 1) m.valor = abs;
      else if (Math.abs(anterior - abs - m.saldo) < 1) m.valor = -abs;
      else m.valor = PALABRAS_SALIDA.test(normalizarTexto(m.descripcion)) ? -abs : abs;
    } else {
      m.valor = PALABRAS_SALIDA.test(normalizarTexto(m.descripcion)) ? -abs : abs;
    }
    anterior = m.saldo ?? (anterior !== null ? anterior + m.valor : null);
  }
}

/** Extrae líneas de texto de un PDF agrupando los fragmentos por coordenada vertical. */
export async function textoLineasPdf(buffer: Buffer): Promise<string[]> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  const lineas: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pagina = await doc.getPage(p);
    const contenido = await pagina.getTextContent();
    const porY = new Map<number, { x: number; s: string }[]>();
    for (const it of contenido.items as any[]) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 2) * 2;
      const lista = porY.get(y) || [];
      lista.push({ x: it.transform[4], s: it.str });
      porY.set(y, lista);
    }
    [...porY.entries()]
      .sort((a, b) => b[0] - a[0])
      .forEach(([, items]) => lineas.push(items.sort((a, b) => a.x - b.x).map(i => i.s.trim()).join('  ')));
  }
  await doc.destroy();
  return lineas;
}

/** Monto que aparece justo después de una etiqueta (las líneas de resumen de los extractos traen dos columnas: "SALDO ANTERIOR $ X   SALDO PROMEDIO $ Y") */
function montoTrasEtiqueta(linea: string, etiqueta: RegExp): number | null {
  const m = linea.match(etiqueta);
  if (!m || m.index === undefined) return null;
  const resto = linea.substring(m.index + m[0].length);
  const monto = resto.match(/^[\s:$]*(-?\s?\$?\s?-?[\d.,]*\d-?)/);
  return monto ? parsearMonto(monto[1]) : null;
}

const RE_MONTO = /-?\$?\s?-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?-?|-?\$?\s?\d+(?:[.,]\d{1,2})?-?/g;

const MESES_RE = '(?:ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic|jan|apr|aug|dec)[a-z.]*';
/** Fecha al inicio de la línea en los formatos que usan los bancos colombianos */
const RE_FECHA_LINEA = new RegExp(
  '^\\s*(' +
    '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}' +                    // 2026/06/01
    '|\\d{1,2}[-/.]\\d{1,2}(?:[-/.]\\d{2,4})?' +             // 01/06/2026 · 1/06 · 01-06
    `|\\d{1,2}[-\\s/]${MESES_RE}(?:[-\\s/]\\d{2,4})?` +       // 01 JUN 2026 · 01-JUN
    `|${MESES_RE}\\s+\\d{1,2}(?:\\s+\\d{2,4})?` +              // JUN 01
    '|\\d{2}\\s\\d{2}(?=\\s+[$A-Za-zÁÉÍÓÚÑáéíóúñ])' +           // 01 06 DESCRIPCIÓN (Davivienda: día y mes en columnas)
  ')\\b',
  'i'
);

function fechaPdf(texto: string, anio?: number, hasta?: { anio: number; mes: number }): string {
  let t = texto.trim().toLowerCase().replace(/\s+/g, ' ');
  const mesAntes = t.match(new RegExp(`^(${MESES_RE})\\s+(\\d{1,2})(?:\\s+(\\d{2,4}))?$`));
  if (mesAntes) t = `${mesAntes[2]} ${mesAntes[1]}${mesAntes[3] ? ' ' + mesAntes[3] : ''}`;
  const dosNumeros = t.match(/^(\d{2}) (\d{2})$/);
  if (dosNumeros) t = `${dosNumeros[1]}/${dosNumeros[2]}`;
  let iso = parsearFecha(t, anio);
  // Extractos que cruzan de año (diciembre → enero): el mes posterior al de corte pertenece al año anterior
  if (iso && hasta && !/\d{4}/.test(t) && !/\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$/.test(t)) {
    const mes = Number(iso.substring(5, 7));
    iso = `${mes > hasta.mes ? hasta.anio - 1 : hasta.anio}${iso.substring(4)}`;
  }
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return iso;
}

const RE_TOKEN_MONTO = /^\(?-?\s?\$?\s?-?[\d.,]*\d\)?-?$/;

/** Separa los montos al final de la línea; reconoce marcas de naturaleza CR / DB y "$" sueltos. */
function montosFinales(tokens: string[]): { montos: number[]; marca?: 1 | -1 } {
  const montos: number[] = [];
  let marca: 1 | -1 | undefined;
  while (tokens.length) {
    let t = tokens[tokens.length - 1].replace(/\s+/g, ' ').trim();
    if (t === '$') { tokens.pop(); continue; }
    const conMarca = t.match(/^(.*?)\s*(CR|DB|DR|C|D|\+)$/);
    if (conMarca && RE_TOKEN_MONTO.test(conMarca[1].replace(/\s/g, '')) && /[.,]/.test(conMarca[1])) {
      if (montos.length === 0 || marca === undefined) marca = /^(CR|C|\+)$/.test(conMarca[2]) ? 1 : -1;
      t = conMarca[1];
    } else if (/^(CR|DB|DR)$/.test(t) && montos.length === 0) {
      marca = t === 'CR' ? 1 : -1;
      tokens.pop();
      continue;
    }
    const limpio = t.replace(/\s/g, '');
    if (!(RE_TOKEN_MONTO.test(limpio) && /[.,]/.test(limpio))) break;
    montos.unshift(parsearMonto(limpio.replace(/^\((.*)\)$/, '-$1')));
    tokens.pop();
  }
  return { montos, marca };
}

/** Corrige el signo de cada movimiento con el saldo corrido (sirve para bancos que no imprimen el signo) */
function corregirSignosConSaldo(movs: MovimientoNormalizado[], saldoInicial: number | null) {
  let anterior = saldoInicial;
  for (const m of movs) {
    if (anterior !== null && m.saldo !== undefined) {
      const abs = Math.abs(m.valor);
      if (Math.abs(anterior + m.valor - m.saldo) > 1) {
        if (Math.abs(anterior + abs - m.saldo) <= 1) m.valor = abs;
        else if (Math.abs(anterior - abs - m.saldo) <= 1) m.valor = -abs;
      }
    }
    anterior = m.saldo ?? (anterior !== null ? anterior + m.valor : null);
  }
}

export async function leerExtractoPdf(buffer: Buffer, nombreArchivo: string): Promise<LecturaMovimientos> {
  const lineas = await textoLineasPdf(buffer);
  const textoCompleto = lineas.join('\n');
  const advertencias: string[] = [];
  const anio = Number((textoCompleto.match(/(?:periodo|desde|hasta|fecha de corte|corte)[^\n]*?(20\d{2})/i) || textoCompleto.match(/\b(20\d{2})\b/) || [])[1]) || undefined;
  const mHasta = textoCompleto.match(/(?:hasta|fecha de corte|corte|al)\s*:?\s*(20\d{2})[-/.](\d{1,2})[-/.]\d{1,2}|(?:hasta|fecha de corte|corte|al)\s*:?\s*\d{1,2}[-/.](\d{1,2})[-/.](20\d{2})/i);
  const hasta = mHasta ? (mHasta[1] ? { anio: +mHasta[1], mes: +mHasta[2] } : { anio: +mHasta[4], mes: +mHasta[3] }) : undefined;

  let saldoInicial: number | null = null;
  let saldoFinal: number | null = null;
  let movs: MovimientoNormalizado[] = [];

  for (const linea of lineas) {
    const norm = normalizarTexto(linea);
    if (saldoInicial === null && /saldo (anterior|inicial)/.test(norm)) {
      const v = montoTrasEtiqueta(linea, /saldo\s+(anterior|inicial)/i);
      if (v !== null) { saldoInicial = v; continue; }
    }
    if (saldoFinal === null && /saldo (actual|final|nuevo)|nuevo saldo/.test(norm)) {
      const v = montoTrasEtiqueta(linea, /saldo\s+(actual|final|nuevo)|nuevo\s+saldo/i);
      if (v !== null) { saldoFinal = v; continue; }
    }
    const mFecha = linea.match(RE_FECHA_LINEA);
    if (!mFecha) continue;
    const fecha = fechaPdf(mFecha[1], anio, hasta);
    if (!fecha) continue;
    const resto = linea.substring(mFecha[0].length);
    const tokens = resto.split(/\s{2,}/).map(t => t.trim()).filter(Boolean);
    // Fechas adicionales (fecha valor / fecha operación) al inicio se descartan
    while (tokens.length && RE_FECHA_LINEA.test(tokens[0]) && fechaPdf(tokens[0].match(RE_FECHA_LINEA)![1], anio, hasta) && tokens[0].replace(RE_FECHA_LINEA, '').trim() === '') tokens.shift();
    let { montos, marca } = montosFinales(tokens);
    if (montos.length === 0) {
      // Formato "fecha · valor · documento · descripción" (Davivienda y otros): el valor va antes del texto
      const i = tokens.findIndex(t => /\$|\d[.,]\d{2}[+-]?$/.test(t) && RE_TOKEN_MONTO.test(t.replace(/\s|[+]$|CR$|DB$/g, '').replace(/^\$/, '')));
      if (i < 0) continue;
      const crudo = tokens[i].replace(/\s/g, '');
      const v = parsearMonto(crudo.replace(/(CR|DB|\+)$/, ''));
      marca = /(\+|CR)$/.test(crudo) ? 1 : /(-|DB)$/.test(crudo) ? -1 : undefined;
      montos = [Math.abs(v) * (v < 0 ? -1 : 1)];
      tokens.splice(i, 1);
    }
    const descripcion = tokens.filter(t => !/^\d{1,6}$/.test(t)).join(' ').trim();
    if (!descripcion || /^saldo/i.test(descripcion)) continue;
    let valor = 0;
    let saldo: number | undefined;
    if (montos.length >= 3) {
      // Débito, Crédito, Saldo
      const [d, c, sal] = montos.slice(-3);
      valor = Math.abs(c) - Math.abs(d);
      saldo = sal;
    } else if (montos.length === 2) {
      valor = montos[0];
      saldo = montos[1];
    } else {
      valor = montos[0];
    }
    if (marca !== undefined) valor = Math.abs(valor) * marca;
    if (valor === 0) continue;
    movs.push({ id: `PDF-${movs.length + 1}`, fecha, descripcion, valor, saldo });
  }

  // Extractos ordenados del más reciente al más antiguo
  if (movs.length > 1 && movs[0].fecha > movs[movs.length - 1].fecha) {
    movs = movs.reverse().map((m, i) => ({ ...m, id: `PDF-${i + 1}` }));
  }

  if (movs.length === 0) {
    advertencias.push('No se reconocieron movimientos en el PDF. Si es un PDF escaneado (imagen), descargue el extracto en Excel/CSV desde la banca en línea o conviértalo con OCR.');
  } else {
    if (saldoInicial === null) {
      const primero = movs.find(m => m.saldo !== undefined);
      if (primero) {
        const idx = movs.indexOf(primero);
        const antes = movs.slice(0, idx).reduce((s, m) => s + m.valor, 0);
        // Saldo inicial deducido del primer saldo impreso (se prueban ambos signos del primer movimiento)
        const candidato = primero.saldo! - primero.valor - antes;
        const alterno = primero.saldo! + primero.valor - antes;
        saldoInicial = movs.every(m => m.valor > 0) ? Math.min(candidato, alterno) : candidato;
      }
    }
    if (movs.some(m => m.saldo !== undefined)) corregirSignosConSaldo(movs, saldoInicial);
    else if (movs.every(m => m.valor > 0)) inferirSignos(movs, saldoInicial);
  }
  const resultado = calcularResumen(movs, saldoInicial, saldoFinal, advertencias);
  resultado.banco_detectado = detectarBanco(textoCompleto.substring(0, 3000) + ' ' + nombreArchivo);
  return resultado;
}

export async function leerExtracto(buffer: Buffer, nombreArchivo: string): Promise<LecturaMovimientos> {
  const esPdf = nombreArchivo.toLowerCase().endsWith('.pdf') || buffer.subarray(0, 5).toString() === '%PDF-';
  return esPdf ? leerExtractoPdf(buffer, nombreArchivo) : leerExtractoTabla(buffer, nombreArchivo);
}

// ==========================================
// Catálogo PUC y balance de prueba
// ==========================================
export interface CuentaLeida { cuenta: string; nombre: string; naturaleza: 'DEBITO' | 'CREDITO' }

export function naturalezaPorCodigo(cuenta: string): 'DEBITO' | 'CREDITO' {
  const clase = cuenta.charAt(0);
  return ['2', '3', '4'].includes(clase) ? 'CREDITO' : 'DEBITO';
}

export function leerPuc(buffer: Buffer, nombreArchivo: string): CuentaLeida[] {
  const filas = leerFilas(buffer, nombreArchivo);
  const enc = detectarEncabezado(
    filas,
    { cuenta: /^codigo|^cuenta$|codigo cuenta|^cta|^numero de cuenta/, nombre: /^nombre|descripcion|^cuenta contable$/, naturaleza: /naturaleza/ },
    ['cuenta', 'nombre']
  );
  const inicio = enc ? enc.fila + 1 : 0;
  const mapa = enc?.mapa || { cuenta: 0, nombre: 1, naturaleza: 2 };
  const vistas = new Set<string>();
  const cuentas: CuentaLeida[] = [];
  for (let i = inicio; i < filas.length; i++) {
    const r = filas[i] || [];
    const cuenta = String(r[mapa.cuenta] ?? '').replace(/[^\d]/g, '');
    const nombre = String(r[mapa.nombre] ?? '').trim();
    if (!cuenta || !nombre || vistas.has(cuenta)) continue;
    vistas.add(cuenta);
    const nat = normalizarTexto(r[mapa.naturaleza]);
    cuentas.push({ cuenta, nombre, naturaleza: nat.startsWith('c') ? 'CREDITO' : nat.startsWith('d') ? 'DEBITO' : naturalezaPorCodigo(cuenta) });
  }
  return cuentas;
}

export interface SaldoLeido {
  cuenta_contable: string;
  nombre_cuenta: string;
  nit_tercero: string;
  nombre_tercero: string;
  saldo_inicial: number;
  debitos: number;
  creditos: number;
  saldo_final: number;
}

export function leerBalance(buffer: Buffer, nombreArchivo: string): SaldoLeido[] {
  const filas = leerFilas(buffer, nombreArchivo);
  const enc = detectarEncabezado(
    filas,
    {
      cuenta: /^codigo|^cuenta$|codigo cuenta|^cta/,
      nombre: /nombre( de la)? cuenta|^descripcion|^nombre$|^cuenta contable$/,
      nit: /identificacion|^nit|documento tercero|cedula/,
      tercero: /nombre( del)? tercero|^tercero|razon social/,
      inicial: /saldo (inicial|anterior)/,
      debitos: /^debito|^movimiento debito|^debe/,
      creditos: /^credito|^movimiento credito|^haber/,
      final: /saldo (final|actual|nuevo)|^nuevo saldo/
    },
    ['cuenta', 'final|inicial']
  );
  if (!enc) throw new Error('No se encontró el encabezado del balance (se esperan columnas Cuenta y Saldo).');
  const { fila, mapa } = enc;
  const saldos: SaldoLeido[] = [];
  for (let i = fila + 1; i < filas.length; i++) {
    const r = filas[i] || [];
    const cuenta = String(r[mapa.cuenta] ?? '').replace(/[^\d]/g, '');
    if (!cuenta) continue;
    const inicial = mapa.inicial !== undefined ? parsearMonto(r[mapa.inicial]) : 0;
    const debitos = mapa.debitos !== undefined ? parsearMonto(r[mapa.debitos]) : 0;
    const creditos = mapa.creditos !== undefined ? parsearMonto(r[mapa.creditos]) : 0;
    const final = mapa.final !== undefined ? parsearMonto(r[mapa.final]) : inicial + debitos - creditos;
    saldos.push({
      cuenta_contable: cuenta,
      nombre_cuenta: String(r[mapa.nombre] ?? '').trim() || cuenta,
      nit_tercero: mapa.nit !== undefined ? String(r[mapa.nit] ?? '').replace(/[^\d]/g, '') : '',
      nombre_tercero: mapa.tercero !== undefined ? String(r[mapa.tercero] ?? '').trim() : '',
      saldo_inicial: inicial,
      debitos,
      creditos,
      saldo_final: final
    });
  }
  return saldos;
}
