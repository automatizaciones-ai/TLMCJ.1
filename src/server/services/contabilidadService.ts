/**
 * Funciones contables de la Consola TLM:
 *  - Auditoría Excel (Consolidado Gerencial + Detalle Línea a Línea)
 *  - Exportación ERP: plantilla de importación de comprobantes de Siigo con partida doble
 *  - Conciliación bancaria determinística (fecha + valor neto, con tolerancia)
 *  - Reporte Excel de conciliación y plano de ajustes contables para Siigo
 *  - Resumen del Dashboard Directivo
 */
import * as XLSX from 'xlsx';
import type { Factura } from '../domain/types.ts';
import type { LecturaMovimientos, MovimientoNormalizado } from './lectorArchivosContables.ts';

// ==========================================
// Utilidades
// ==========================================
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** AAAA-MM-DD → DD/MM/AAAA (formato que espera la plantilla de Siigo) */
export const fechaSiigo = (iso: string): string => {
  const m = (iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

export function libroABuffer(wb: XLSX.WorkBook): Buffer {
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function hoja(filas: Record<string, unknown>[], anchos?: number[], encabezados?: string[]): XLSX.WorkSheet {
  const ws = filas.length
    ? XLSX.utils.json_to_sheet(filas, encabezados ? { header: encabezados } : undefined)
    : XLSX.utils.aoa_to_sheet([encabezados || ['Sin datos']]);
  const cols = encabezados || Object.keys(filas[0] || {});
  ws['!cols'] = cols.map((c, i) => ({ wch: anchos?.[i] ?? Math.min(Math.max(String(c).length + 2, 12), 60) }));
  if (ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] };
  return ws;
}

export function retenciones(f: Factura) {
  const retefuente = Math.abs(f.retencion_valor || 0);
  const reteica = Math.round(Math.abs(f.subtotal || 0) * (f.reteica_tarifa || 0) / 1000);
  const reteiva = Math.round(Math.abs(f.iva || 0) * (f.reteiva_porc || 0) / 100);
  return { retefuente, reteica, reteiva, total: retefuente + reteica + reteiva };
}

const lineasDe = (f: Factura) =>
  f.items && f.items.length
    ? f.items
    : [{ linea: 1, descripcion_item: f.descripcion_item, cantidad: f.cantidad, valor_unitario: f.valor_unitario, subtotal: Math.abs(f.subtotal), iva: Math.abs(f.iva), iva_porc: f.subtotal ? Math.round((f.iva / f.subtotal) * 100) : 0 } as any];

// ==========================================
// 1. Auditoría Excel
// ==========================================
export function generarAuditoriaExcel(facturas: Factura[]): Buffer {
  const consolidado = facturas.map(f => {
    const ret = retenciones(f);
    return {
      'Factura N°': f.factura_num,
      CUFE: f.cufe_hash,
      'NIT Tercero': f.nit_tercero,
      'Razón Social': f.proveedor,
      Teléfono: f.telefono || '',
      Dirección: f.direccion || '',
      Ciudad: f.ciudad || '',
      Departamento: f.departamento || '',
      Correo: f.correo || '',
      Tipo: f.tipo_operacion === 'VENTA' ? 'Venta' : 'Compra',
      Documento: f.tipo_comprobante,
      'Fecha Emisión': f.fecha,
      'Fecha Vencimiento': f.fecha_vencimiento || '',
      'Forma de Pago': f.forma_pago,
      'Medio de Pago': f.medio_pago,
      'N° Ítems': lineasDe(f).length,
      Subtotal: f.subtotal,
      IVA: f.iva,
      'Total Factura': f.total ?? f.subtotal + f.iva,
      ReteFuente: ret.retefuente,
      ReteICA: ret.reteica,
      ReteIVA: ret.reteiva,
      'Neto a Pagar/Cobrar': r2((f.total ?? f.subtotal + f.iva) - ret.total),
      'Cuenta Contable': f.cuenta_gasto,
      'Banco Siigo': f.banco_siigo || 'Default (Siigo)',
      Estado: f.estado_revision,
      'Archivo Origen': f.datos_ubl?.archivo_origen || ''
    };
  });

  const detalle = facturas.flatMap(f =>
    lineasDe(f).map((l: any) => ({
      'Fecha Emisión': f.fecha,
      'Fecha Vencimiento': f.fecha_vencimiento || '',
      'Factura N°': f.factura_num,
      'NIT Tercero': f.nit_tercero,
      'Razón Social': f.proveedor,
      Teléfono: f.telefono || '',
      Dirección: f.direccion || '',
      Ciudad: f.ciudad || '',
      Departamento: f.departamento || '',
      Correo: f.correo || '',
      Tipo: f.tipo_operacion === 'VENTA' ? 'Venta' : 'Compra',
      Línea: l.linea,
      Código: l.codigo || '',
      'Ítem / Descripción': l.descripcion_item,
      'U/M': l.unidad || '',
      Cantidad: l.cantidad,
      'Valor Unitario': l.valor_unitario,
      Descuento: l.descuento || 0,
      Subtotal: l.subtotal,
      'IVA %': l.iva_porc || 0,
      IVA: l.iva,
      INC: l.inc || 0,
      'Total Línea': r2((l.subtotal || 0) + (l.iva || 0) + (l.inc || 0)),
      'Cuenta Contable': l.cuenta_contable || f.cuenta_gasto,
      CUFE: f.cufe_hash
    }))
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, hoja(consolidado, [12, 40, 14, 38, 16, 30, 16, 16, 28]), 'Consolidado Gerencial');
  XLSX.utils.book_append_sheet(wb, hoja(detalle), 'Detalle Línea a Línea');
  return libroABuffer(wb);
}

// ==========================================
// 2. Plantilla de importación de comprobantes contables Siigo
// ==========================================
export const COLUMNAS_SIIGO = [
  'Tipo de comprobante',
  'Consecutivo comprobante',
  'Fecha de elaboración',
  'Sigla moneda',
  'Tasa de cambio',
  'Código cuenta contable',
  'Identificación tercero',
  'Sucursal',
  'Código producto',
  'Código de bodega',
  'Acción',
  'Cantidad producto',
  'Prefijo',
  'Consecutivo',
  'No. cuota',
  'Fecha vencimiento',
  'Código impuesto',
  'Código grupo activo fijo',
  'Código activo fijo',
  'Descripción',
  'Código centro/subcentro de costos',
  'Débito',
  'Crédito',
  'Observaciones'
] as const;

export interface MovimientoContable {
  cuenta: string;
  tercero: string;
  descripcion: string;
  debito: number;
  credito: number;
  prefijo?: string;
  consecutivo_documento?: string;
  fecha_vencimiento?: string;
  observaciones?: string;
}

export interface Comprobante {
  fecha: string; // AAAA-MM-DD
  movimientos: MovimientoContable[];
  referencia: string;
}

export interface CuentasErp {
  iva_generado: string;
  iva_descontable: string;
  clientes: string;
  proveedores: string;
  retefuente_por_pagar: string;
  reteica_por_pagar: string;
  reteiva_por_pagar: string;
  anticipo_retefuente: string;
  anticipo_reteica: string;
  anticipo_reteiva: string;
}

export const CUENTAS_ERP_DEFECTO: CuentasErp = {
  iva_generado: '24080105',
  iva_descontable: '24080101',
  clientes: '13050501',
  proveedores: '22050101',
  retefuente_por_pagar: '23652501',
  reteica_por_pagar: '23680501',
  reteiva_por_pagar: '23670501',
  anticipo_retefuente: '13551501',
  anticipo_reteica: '13551801',
  anticipo_reteiva: '13551701'
};

/** Agrega un movimiento respetando el signo: un valor negativo pasa al lado contrario (notas crédito). */
function mov(lista: MovimientoContable[], lado: 'D' | 'C', valor: number, base: Omit<MovimientoContable, 'debito' | 'credito'>) {
  const v = r2(valor);
  if (!v) return;
  const ladoReal = v < 0 ? (lado === 'D' ? 'C' : 'D') : lado;
  lista.push({ ...base, debito: ladoReal === 'D' ? Math.abs(v) : 0, credito: ladoReal === 'C' ? Math.abs(v) : 0 });
}

/** Construye el asiento de partida doble de una factura (venta o compra). */
export function asientoFactura(f: Factura, cuentas: CuentasErp = CUENTAS_ERP_DEFECTO): Comprobante {
  const movimientos: MovimientoContable[] = [];
  const tercero = f.nit_tercero;
  const ret = retenciones(f);
  const signo = (f.subtotal || 0) < 0 ? -1 : 1;
  const lineas = lineasDe(f);
  const etiquetaDoc = `Factura ${f.factura_num}`;
  const contrapartidaBanco = f.banco_siigo && /^\d{4,}$/.test(f.banco_siigo) ? f.banco_siigo : '';
  const venc = f.fecha_vencimiento || f.fecha;
  const [prefijo, consecutivoDoc] = (() => {
    const m = f.factura_num.match(/^([A-Za-z]*)[-\s]?(\d+)$/);
    return m ? [m[1], m[2]] : ['', f.factura_num];
  })();
  const docCruce = { prefijo, consecutivo_documento: consecutivoDoc, fecha_vencimiento: venc };

  if (f.tipo_operacion === 'VENTA') {
    for (const l of lineas) {
      mov(movimientos, 'C', signo * Math.abs(l.subtotal), { cuenta: l.cuenta_contable || f.cuenta_gasto, tercero, descripcion: l.descripcion_item });
    }
    mov(movimientos, 'C', f.iva, { cuenta: cuentas.iva_generado, tercero, descripcion: `IVA ${etiquetaDoc}` });
    mov(movimientos, 'D', signo * ret.retefuente, { cuenta: cuentas.anticipo_retefuente, tercero, descripcion: `ReteFuente ${etiquetaDoc}` });
    mov(movimientos, 'D', signo * ret.reteica, { cuenta: cuentas.anticipo_reteica, tercero, descripcion: `ReteICA ${etiquetaDoc}` });
    mov(movimientos, 'D', signo * ret.reteiva, { cuenta: cuentas.anticipo_reteiva, tercero, descripcion: `ReteIVA ${etiquetaDoc}` });
  } else {
    for (const l of lineas) {
      mov(movimientos, 'D', signo * Math.abs(l.subtotal), { cuenta: l.cuenta_contable || f.cuenta_gasto, tercero, descripcion: l.descripcion_item });
    }
    mov(movimientos, 'D', f.iva, { cuenta: cuentas.iva_descontable, tercero, descripcion: `IVA ${etiquetaDoc}` });
    mov(movimientos, 'C', signo * ret.retefuente, { cuenta: cuentas.retefuente_por_pagar, tercero, descripcion: `ReteFuente ${etiquetaDoc}` });
    mov(movimientos, 'C', signo * ret.reteica, { cuenta: cuentas.reteica_por_pagar, tercero, descripcion: `ReteICA ${etiquetaDoc}` });
    mov(movimientos, 'C', signo * ret.reteiva, { cuenta: cuentas.reteiva_por_pagar, tercero, descripcion: `ReteIVA ${etiquetaDoc}` });
  }

  // Contrapartida (cliente / proveedor / banco) por la diferencia, garantiza el cuadre exacto
  const debitos = movimientos.reduce((s, m) => s + m.debito, 0);
  const creditos = movimientos.reduce((s, m) => s + m.credito, 0);
  const diferencia = r2(creditos - debitos); // > 0 → falta débito
  const cuentaContra = contrapartidaBanco || (f.tipo_operacion === 'VENTA' ? cuentas.clientes : cuentas.proveedores);
  mov(movimientos, 'D', diferencia, {
    cuenta: cuentaContra,
    tercero,
    descripcion: `CXP/CXC ${etiquetaDoc}`,
    ...(contrapartidaBanco ? {} : docCruce)
  });

  return { fecha: f.fecha, movimientos, referencia: f.factura_num };
}

export interface OpcionesPlano {
  tipo_comprobante: string;
  consecutivo_inicial: number;
  prefijo?: string;
  sigla_moneda?: string;
  centro_costos?: string;
  /** true: todos los movimientos en un solo comprobante; false: un comprobante por documento */
  un_solo_comprobante?: boolean;
}

export function validarCuadre(comprobantes: Comprobante[]): { ok: boolean; descuadres: { referencia: string; diferencia: number }[] } {
  const descuadres = comprobantes
    .map(c => ({ referencia: c.referencia, diferencia: r2(c.movimientos.reduce((s, m) => s + m.debito - m.credito, 0)) }))
    .filter(d => Math.abs(d.diferencia) > 0.009);
  return { ok: descuadres.length === 0, descuadres };
}

export function planoSiigo(comprobantes: Comprobante[], opciones: OpcionesPlano, nombreHoja = 'Datos'): { buffer: Buffer; filas: number; consecutivo_final: number } {
  const filas: Record<string, unknown>[] = [];
  let consecutivo = Number(opciones.consecutivo_inicial) || 1;
  comprobantes.forEach((c, idx) => {
    if (opciones.un_solo_comprobante && idx > 0) {
      // mismo consecutivo
    } else if (idx > 0) {
      consecutivo++;
    }
    for (const m of c.movimientos) {
      filas.push({
        'Tipo de comprobante': opciones.tipo_comprobante,
        'Consecutivo comprobante': consecutivo,
        'Fecha de elaboración': fechaSiigo(c.fecha),
        'Sigla moneda': opciones.sigla_moneda || '',
        'Tasa de cambio': '',
        'Código cuenta contable': m.cuenta,
        'Identificación tercero': m.tercero,
        Sucursal: '',
        'Código producto': '',
        'Código de bodega': '',
        Acción: '',
        'Cantidad producto': '',
        Prefijo: m.prefijo ?? opciones.prefijo ?? '',
        Consecutivo: m.consecutivo_documento ?? '',
        'No. cuota': m.consecutivo_documento ? 1 : '',
        'Fecha vencimiento': m.fecha_vencimiento ? fechaSiigo(m.fecha_vencimiento) : '',
        'Código impuesto': '',
        'Código grupo activo fijo': '',
        'Código activo fijo': '',
        Descripción: (m.descripcion || '').substring(0, 100),
        'Código centro/subcentro de costos': opciones.centro_costos || '',
        Débito: m.debito,
        Crédito: m.credito,
        Observaciones: m.observaciones || ''
      });
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, hoja(filas, undefined, [...COLUMNAS_SIIGO]), nombreHoja);
  return { buffer: libroABuffer(wb), filas: filas.length, consecutivo_final: consecutivo };
}

// ==========================================
// 3. Conciliación bancaria
// ==========================================
export type TipoCruce = 'EXACTA' | 'HOLGURA' | 'VALOR' | 'AGRUPADA_BANCO' | 'AGRUPADA_LIBROS';

export const ETIQUETA_CRUCE: Record<TipoCruce, string> = {
  EXACTA: 'Misma fecha y valor',
  HOLGURA: 'Valor igual, fecha dentro de la holgura',
  VALOR: 'Mismo valor, distinta fecha en el periodo',
  AGRUPADA_BANCO: 'Un registro contable = varios movimientos del banco',
  AGRUPADA_LIBROS: 'Un movimiento del banco = varios registros contables'
};

export interface PartidaConciliada {
  fecha: string;
  comprobante?: string;
  detalle: string;
  valor: number;
  valor_banco: number;
  diferencia: number;
  descripcion_banco: string;
  /** Primer movimiento de cada lado (compatibilidad); los cruces agrupados traen todos en ids_* */
  id_libro: string;
  id_banco: string;
  tipo: TipoCruce;
  ids_libro: string[];
  ids_banco: string[];
  fecha_banco: string;
  dias_diferencia: number;
}

export interface ResultadoConciliacion {
  id_empresa: number;
  ejecutada_en: string;
  tolerancia: number;
  dias_holgura: number;
  banco?: string;
  archivo_auxiliar?: string;
  archivo_extracto?: string;
  libros: { saldo_inicial: number; neto: number; saldo_final: number; movimientos: number; saldos_consistentes: boolean };
  extracto: { saldo_inicial: number; neto: number; saldo_final: number; movimientos: number; saldos_consistentes: boolean };
  diferencia_saldos: number;
  cuadrado: boolean;
  conciliadas: PartidaConciliada[];
  faltan_en_libros: MovimientoNormalizado[];
  faltan_en_banco: MovimientoNormalizado[];
  totales: { conciliado: number; pendiente_libros: number; pendiente_banco: number };
  /** Partidas conciliadas por tipo de cruce */
  por_tipo: Partial<Record<TipoCruce, number>>;
  advertencias: string[];
}

const diasEntre = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

const sinTildes = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

/**
 * Familias de cargos y abonos bancarios que los contadores suelen registrar en un solo comprobante al cierre del mes
 * (Siigo: "CC-xx" con el total de 4x1000, de intereses o de comisiones + IVA). Válido para extractos de cualquier banco.
 */
const FAMILIAS_BANCARIAS: [string, RegExp][] = [
  ['GMF 4x1000', /4\s*X\s*1000|GMF|GRAVAMEN|IMPTO GOBIERNO|IMPUESTO GOBIERNO|IMP\.? ?GOB/],
  ['Intereses / rendimientos', /INTERES|RENDIMIENTO|ABONO INT/],
  ['Comisiones, servicios e IVA', /COMIS|SERVICIO|CUOTA (DE )?MANEJO|IVA|COBRO|CARGO|COSTO TRANSAC|TARIFA|PORTES|CHEQUERA|SWIFT/],
  ['Retenciones', /RETEFUENTE|RETENCION|RTE ?FTE|RETE ?ICA|RETE ?IVA/]
];
const familiaDe = (m: MovimientoNormalizado) => FAMILIAS_BANCARIAS.find(([, re]) => re.test(sinTildes(m.descripcion)))?.[0];

/** Busca un subconjunto (máx. 18 elementos candidatos) cuya suma sea `objetivo` ± tolerancia. */
function subconjuntoQueSuma(candidatos: MovimientoNormalizado[], objetivo: number, tolerancia: number): MovimientoNormalizado[] | null {
  const lista = candidatos.slice(0, 18);
  const n = lista.length;
  if (n < 2) return null;
  // Primero el grupo completo (lo más común: el total del mes)
  const total = lista.reduce((s, m) => s + m.valor, 0);
  if (Math.abs(total - objetivo) <= tolerancia) return lista;
  let mejor: { mask: number; dif: number; cuenta: number } | null = null;
  for (let mask = 1; mask < (1 << n); mask++) {
    const cuenta = (mask.toString(2).match(/1/g) || []).length;
    if (cuenta < 2) continue;
    let suma = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) suma += lista[i].valor;
    const dif = Math.abs(suma - objetivo);
    if (dif <= tolerancia && (!mejor || dif < mejor.dif || (dif === mejor.dif && cuenta > mejor.cuenta))) mejor = { mask, dif, cuenta };
  }
  return mejor ? lista.filter((_, i) => mejor!.mask & (1 << i)) : null;
}

export function conciliar(
  idEmpresa: number,
  libros: LecturaMovimientos,
  extracto: LecturaMovimientos,
  tolerancia = 0,
  diasHolgura = 0,
  opciones: { cruce_por_valor?: boolean; cruce_agrupado?: boolean } = {}
): ResultadoConciliacion {
  const { cruce_por_valor = true, cruce_agrupado = true } = opciones;
  const usadosLibro = new Set<string>();
  const usadosBanco = new Set<string>();
  const conciliadas: PartidaConciliada[] = [];
  const tolGrupo = Math.max(tolerancia, 1);

  const registrar = (tipo: TipoCruce, ls: MovimientoNormalizado[], bs: MovimientoNormalizado[]) => {
    ls.forEach(l => usadosLibro.add(l.id));
    bs.forEach(b => usadosBanco.add(b.id));
    const valorL = r2(ls.reduce((s, m) => s + m.valor, 0));
    const valorB = r2(bs.reduce((s, m) => s + m.valor, 0));
    const l0 = ls[0];
    const b0 = bs[0];
    const descBanco = bs.length > 1
      ? `${bs.length} movimientos: ${[...new Set(bs.map(b => b.descripcion))].slice(0, 3).join(' · ')}${new Set(bs.map(b => b.descripcion)).size > 3 ? '…' : ''}`
      : b0.descripcion;
    const detalle = ls.length > 1
      ? `${ls.length} registros: ${ls.map(l => l.comprobante || l.tercero || l.descripcion).slice(0, 4).join(', ')}${ls.length > 4 ? '…' : ''}`
      : (l0.tercero || l0.descripcion);
    conciliadas.push({
      fecha: l0.fecha,
      comprobante: ls.length > 1 ? ls.map(l => l.comprobante).filter(Boolean).slice(0, 3).join(', ') || undefined : l0.comprobante,
      detalle,
      valor: valorL,
      valor_banco: valorB,
      diferencia: r2(valorL - valorB),
      descripcion_banco: descBanco,
      id_libro: l0.id,
      id_banco: b0.id,
      tipo,
      ids_libro: ls.map(l => l.id),
      ids_banco: bs.map(b => b.id),
      fecha_banco: b0.fecha,
      dias_diferencia: Math.round(diasEntre(l0.fecha, b0.fecha))
    });
  };

  // Pasadas 1-3 (uno a uno): misma fecha → dentro de la holgura → mismo valor en cualquier fecha del periodo.
  const pasadas: [TipoCruce, number][] = [['EXACTA', 0]];
  if (diasHolgura > 0) pasadas.push(['HOLGURA', diasHolgura]);
  if (cruce_por_valor) pasadas.push(['VALOR', Infinity]);
  for (const [tipo, holgura] of pasadas) {
    for (const b of extracto.movimientos) {
      if (usadosBanco.has(b.id)) continue;
      let mejor: { l: MovimientoNormalizado; dif: number; dias: number } | null = null;
      for (const l of libros.movimientos) {
        if (usadosLibro.has(l.id)) continue;
        if (Math.sign(l.valor) !== Math.sign(b.valor)) continue;
        const dias = diasEntre(l.fecha, b.fecha);
        if (dias > holgura) continue;
        // En el cruce por valor solo se acepta coincidencia exacta (la tolerancia aplica a fechas cercanas)
        const dif = Math.abs(l.valor - b.valor);
        if (dif > (tipo === 'VALOR' ? 0.01 : tolerancia)) continue;
        if (!mejor || dif < mejor.dif || (dif === mejor.dif && dias < mejor.dias)) mejor = { l, dif, dias };
      }
      if (mejor) registrar(tipo, [mejor.l], [b]);
    }
  }

  if (cruce_agrupado) {
    // Pasada 4: un comprobante contable = suma de varios movimientos del banco (4x1000, intereses, comisiones + IVA del mes…)
    for (const l of libros.movimientos) {
      if (usadosLibro.has(l.id)) continue;
      const libres = extracto.movimientos.filter(b => !usadosBanco.has(b.id) && Math.sign(b.valor) === Math.sign(l.valor));
      if (libres.length < 2) continue;
      const grupos = new Map<string, MovimientoNormalizado[]>();
      for (const b of libres) {
        const fam = familiaDe(b);
        if (fam) grupos.set(fam, [...(grupos.get(fam) || []), b]);
        const desc = `DESC:${sinTildes(b.descripcion).replace(/\d+/g, '').replace(/\s+/g, ' ').trim()}`;
        grupos.set(desc, [...(grupos.get(desc) || []), b]);
      }
      let encontrado: MovimientoNormalizado[] | null = null;
      for (const grupo of grupos.values()) {
        if (grupo.length < 2) continue;
        encontrado = subconjuntoQueSuma(grupo, l.valor, tolGrupo);
        if (encontrado) break;
      }
      // Familias combinadas (p. ej. comisiones + 4x1000 en un solo comprobante)
      if (!encontrado) {
        const familias = FAMILIAS_BANCARIAS.map(([f]) => grupos.get(f) || []).filter(g => g.length);
        for (let i = 0; i < familias.length && !encontrado; i++) {
          for (let j = i + 1; j < familias.length && !encontrado; j++) {
            const union = [...familias[i], ...familias[j]];
            if (Math.abs(union.reduce((s, m) => s + m.valor, 0) - l.valor) <= tolGrupo) encontrado = union;
          }
        }
      }
      if (encontrado) registrar('AGRUPADA_BANCO', [l], encontrado);
    }

    // Pasada 5: un movimiento del banco (pago masivo, consignación de varios recibos) = varios registros contables de fechas cercanas
    for (const b of extracto.movimientos) {
      if (usadosBanco.has(b.id)) continue;
      const cercanos = libros.movimientos
        .filter(l => !usadosLibro.has(l.id) && Math.sign(l.valor) === Math.sign(b.valor) && diasEntre(l.fecha, b.fecha) <= Math.max(diasHolgura, 3))
        .sort((x, y) => diasEntre(x.fecha, b.fecha) - diasEntre(y.fecha, b.fecha));
      const grupo = subconjuntoQueSuma(cercanos, b.valor, tolGrupo);
      if (grupo) registrar('AGRUPADA_LIBROS', grupo, [b]);
    }
  }

  const faltanEnLibros = extracto.movimientos.filter(b => !usadosBanco.has(b.id));
  const faltanEnBanco = libros.movimientos.filter(l => !usadosLibro.has(l.id));
  conciliadas.sort((a, b) => a.fecha.localeCompare(b.fecha));
  const diferencia = r2(libros.saldo_final - extracto.saldo_final);

  return {
    id_empresa: idEmpresa,
    ejecutada_en: new Date().toISOString(),
    tolerancia,
    dias_holgura: diasHolgura,
    banco: extracto.banco_detectado,
    libros: { saldo_inicial: libros.saldo_inicial, neto: libros.neto, saldo_final: libros.saldo_final, movimientos: libros.movimientos.length, saldos_consistentes: libros.saldos_consistentes },
    extracto: { saldo_inicial: extracto.saldo_inicial, neto: extracto.neto, saldo_final: extracto.saldo_final, movimientos: extracto.movimientos.length, saldos_consistentes: extracto.saldos_consistentes },
    diferencia_saldos: diferencia,
    cuadrado: Math.abs(diferencia) <= Math.max(1, tolerancia),
    conciliadas,
    faltan_en_libros: faltanEnLibros,
    faltan_en_banco: faltanEnBanco,
    totales: {
      conciliado: r2(conciliadas.reduce((s, c) => s + c.valor, 0)),
      pendiente_libros: r2(faltanEnLibros.reduce((s, m) => s + m.valor, 0)),
      pendiente_banco: r2(faltanEnBanco.reduce((s, m) => s + m.valor, 0))
    },
    por_tipo: conciliadas.reduce((acc, c) => ({ ...acc, [c.tipo]: (acc[c.tipo] || 0) + 1 }), {} as Partial<Record<TipoCruce, number>>),
    advertencias: [...libros.advertencias.map(a => `Auxiliar: ${a}`), ...extracto.advertencias.map(a => `Extracto: ${a}`)]
  };
}

export function reporteConciliacionExcel(r: ResultadoConciliacion, nombreEmpresa: string): Buffer {
  const wb = XLSX.utils.book_new();
  const resumen = [
    ['Conciliación bancaria', nombreEmpresa],
    ['Banco', r.banco || 'No detectado'],
    ['Ejecutada', r.ejecutada_en],
    ['Tolerancia ($ COP)', r.tolerancia],
    ['Días de holgura', r.dias_holgura],
    [],
    ['', 'Saldo inicial', 'Neto movimientos', 'Saldo final', 'Movimientos'],
    ['Auxiliar libros (ERP)', r.libros.saldo_inicial, r.libros.neto, r.libros.saldo_final, r.libros.movimientos],
    ['Extracto bancario', r.extracto.saldo_inicial, r.extracto.neto, r.extracto.saldo_final, r.extracto.movimientos],
    ['Diferencia libros vs extracto', '', '', r.diferencia_saldos, r.cuadrado ? 'CUADRADO' : 'DESCUADRADO'],
    [],
    ['Lista', 'Partidas', 'Total'],
    ['1. Partidas conciliadas', r.conciliadas.length, r.totales.conciliado],
    ['2. Faltan en libros (en extracto, pendientes de contabilizar)', r.faltan_en_libros.length, r.totales.pendiente_libros],
    ['3. Faltan en banco (en libros, pendientes de cobro/pago)', r.faltan_en_banco.length, r.totales.pendiente_banco],
    [],
    ...r.advertencias.map(a => ['Advertencia', a])
  ];
  const wsRes = XLSX.utils.aoa_to_sheet(resumen);
  wsRes['!cols'] = [{ wch: 58 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsRes, 'Resumen');
  XLSX.utils.book_append_sheet(wb, hoja(r.conciliadas.map(c => ({
    'Fecha libros': c.fecha, 'Fecha banco': c.fecha_banco || '', Comprobante: c.comprobante || '', Detalle: c.detalle, 'Valor libros': c.valor, 'Valor banco': c.valor_banco, Diferencia: c.diferencia, 'Descripción banco': c.descripcion_banco, 'Tipo de cruce': c.tipo ? ETIQUETA_CRUCE[c.tipo] : '', 'Movs. banco': c.ids_banco?.length || 1, 'Movs. libros': c.ids_libro?.length || 1
  }))), 'Conciliadas');
  XLSX.utils.book_append_sheet(wb, hoja(r.faltan_en_libros.map(m => ({
    Fecha: m.fecha, Descripción: m.descripcion, Referencia: m.referencia || '', Valor: m.valor, Saldo: m.saldo ?? ''
  }))), 'Faltan en libros');
  XLSX.utils.book_append_sheet(wb, hoja(r.faltan_en_banco.map(m => ({
    Fecha: m.fecha, Comprobante: m.comprobante || '', Descripción: m.descripcion, Tercero: m.tercero || '', Valor: m.valor
  }))), 'Faltan en banco');
  return libroABuffer(wb);
}

export function extractoAExcel(lectura: LecturaMovimientos): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, hoja(lectura.movimientos.map(m => ({
    Fecha: m.fecha,
    Descripción: m.descripcion,
    Referencia: m.referencia || '',
    Débito: m.valor < 0 ? Math.abs(m.valor) : 0,
    Crédito: m.valor > 0 ? m.valor : 0,
    Valor: m.valor,
    Saldo: m.saldo ?? ''
  })), [12, 60, 16, 16, 16, 16, 16]), 'Extracto');
  const ws = XLSX.utils.aoa_to_sheet([
    ['Banco', lectura.banco_detectado || 'No detectado'],
    ['Saldo inicial', lectura.saldo_inicial],
    ['Neto movimientos', lectura.neto],
    ['Saldo final', lectura.saldo_final],
    ['Saldos consistentes', lectura.saldos_consistentes ? 'Sí' : 'No'],
    ...lectura.advertencias.map(a => ['Advertencia', a])
  ]);
  ws['!cols'] = [{ wch: 22 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Resumen');
  return libroABuffer(wb);
}

export interface ParametrosAjuste {
  nit_banco: string;
  cuenta_banco: string;
  tipo_comprobante: string;
  consecutivo_inicial: number;
  cuenta_gasto_defecto: string;
  cuenta_gmf: string;
  cuenta_iva_descontable: string;
  /** Contrapartida de las entradas de dinero no contabilizadas (abonos, consignaciones) */
  cuenta_ingresos_defecto: string;
  /** Rendimientos / intereses ganados */
  cuenta_rendimientos?: string;
  un_solo_comprobante?: boolean;
}

const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Cuenta de contrapartida según el texto del movimiento y su signo (corrige el error de llevar abonos al gasto). */
export function cuentaAjuste(m: MovimientoNormalizado, p: ParametrosAjuste): { cuenta: string; motivo: string } {
  const d = norm(m.descripcion);
  const esGmf = /4\s?x\s?1000|gravamen|\bgmf\b/.test(d);
  if (esGmf) return { cuenta: p.cuenta_gmf, motivo: /reintegro|devolucion|reverso/.test(d) ? 'Reintegro GMF' : 'GMF 4x1000' };
  if (/\biva\b/.test(d)) return { cuenta: p.cuenta_iva_descontable, motivo: 'IVA descontable' };
  if (m.valor > 0) {
    if (/interes|rendimiento/.test(d) && p.cuenta_rendimientos) return { cuenta: p.cuenta_rendimientos, motivo: 'Rendimientos financieros' };
    return { cuenta: p.cuenta_ingresos_defecto, motivo: 'Entrada no contabilizada' };
  }
  return { cuenta: p.cuenta_gasto_defecto, motivo: 'Gasto bancario / salida no contabilizada' };
}

export function comprobantesAjuste(movs: MovimientoNormalizado[], p: ParametrosAjuste): Comprobante[] {
  return movs.map(m => {
    const { cuenta, motivo } = cuentaAjuste(m, p);
    const valor = Math.abs(m.valor);
    const observaciones = `Ajuste conciliación: ${motivo}`;
    const movimientos: MovimientoContable[] = m.valor < 0
      ? [
          { cuenta, tercero: p.nit_banco, descripcion: m.descripcion, debito: valor, credito: 0, observaciones },
          { cuenta: p.cuenta_banco, tercero: p.nit_banco, descripcion: m.descripcion, debito: 0, credito: valor, observaciones }
        ]
      : [
          { cuenta: p.cuenta_banco, tercero: p.nit_banco, descripcion: m.descripcion, debito: valor, credito: 0, observaciones },
          { cuenta, tercero: p.nit_banco, descripcion: m.descripcion, debito: 0, credito: valor, observaciones }
        ];
    return { fecha: m.fecha, movimientos, referencia: m.id };
  });
}

// ==========================================
// 4. Dashboard Directivo
// ==========================================
export type Agrupacion = 'dia' | 'quincena' | 'mes';

export function claveAgrupacion(fecha: string, agrupacion: Agrupacion): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(fecha)) return 'Sin fecha';
  if (agrupacion === 'dia') return fecha.substring(0, 10);
  if (agrupacion === 'mes') return fecha.substring(0, 7);
  return `${fecha.substring(0, 7)} ${Number(fecha.substring(8, 10)) <= 15 ? 'Q1' : 'Q2'}`;
}

export function resumenDashboard(facturas: Factura[], agrupacion: Agrupacion = 'quincena') {
  const ventas = facturas.filter(f => f.tipo_operacion === 'VENTA');
  const compras = facturas.filter(f => f.tipo_operacion !== 'VENTA');
  const ingresos = r2(ventas.reduce((s, f) => s + (f.subtotal || 0), 0));
  const gastos = r2(compras.reduce((s, f) => s + (f.subtotal || 0), 0));
  const retefuente = r2(compras.reduce((s, f) => s + retenciones(f).retefuente, 0));
  const margen = ingresos > 0 ? r2(((ingresos - gastos) / ingresos) * 100) : 0;

  const serie = new Map<string, { periodo: string; ventas: number; compras: number }>();
  for (const f of facturas) {
    const k = claveAgrupacion(f.fecha, agrupacion);
    const p = serie.get(k) || { periodo: k, ventas: 0, compras: 0 };
    if (f.tipo_operacion === 'VENTA') p.ventas += f.subtotal || 0;
    else p.compras += f.subtotal || 0;
    serie.set(k, p);
  }

  const porProveedor = new Map<string, { tercero: string; nit: string; valor: number }>();
  for (const f of compras) {
    const p = porProveedor.get(f.nit_tercero) || { tercero: f.proveedor, nit: f.nit_tercero, valor: 0 };
    p.valor += f.subtotal || 0;
    porProveedor.set(f.nit_tercero, p);
  }

  return {
    ingresos_totales: ingresos,
    gastos_compras: gastos,
    margen_bruto_porc: margen,
    retefuente_f350: retefuente,
    facturas_venta: ventas.length,
    facturas_compra: compras.length,
    facturas_unicas: new Set(facturas.map(f => f.cufe_hash)).size,
    lineas_contables: facturas.reduce((s, f) => s + (f.items?.length || 1), 0),
    agrupacion,
    serie: [...serie.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)).map(p => ({ ...p, ventas: r2(p.ventas), compras: r2(p.compras) })),
    top_gasto: [...porProveedor.values()].sort((a, b) => b.valor - a.valor).slice(0, 5).map(p => ({ ...p, valor: r2(p.valor) }))
  };
}
