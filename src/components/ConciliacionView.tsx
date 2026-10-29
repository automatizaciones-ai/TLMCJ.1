import React, { useEffect, useMemo, useState } from 'react';
import { BANCOS_EXTRACTO } from '../shared/catalogosDian.ts';
import { Scale, Zap, FileSpreadsheet, FileText, BookOpen, Landmark, AlertTriangle, CheckCircle2, Loader2, X, FilePlus2, Info } from 'lucide-react';
import { apiJson, descargarArchivo, textoArchivado, formatoCOP } from '../lib/api.ts';

interface Movimiento {
  id: string;
  fecha: string;
  descripcion: string;
  comprobante?: string;
  tercero?: string;
  referencia?: string;
  valor: number;
  saldo?: number;
}

interface Partida {
  fecha: string;
  comprobante?: string;
  detalle: string;
  valor: number;
  valor_banco: number;
  diferencia: number;
  descripcion_banco: string;
  tipo?: 'EXACTA' | 'HOLGURA' | 'VALOR' | 'AGRUPADA_BANCO' | 'AGRUPADA_LIBROS';
  fecha_banco?: string;
  ids_banco?: string[];
  ids_libro?: string[];
}

const TIPO_CRUCE: Record<string, { corto: string; largo: string; clase: string }> = {
  EXACTA: { corto: 'Exacta', largo: 'Misma fecha y valor', clase: 'bg-emerald-100 text-emerald-700' },
  HOLGURA: { corto: 'Holgura', largo: 'Valor igual, fecha dentro de los días de holgura', clase: 'bg-sky-100 text-sky-700' },
  VALOR: { corto: 'Por valor', largo: 'Mismo valor, registrado en otra fecha del periodo', clase: 'bg-indigo-100 text-indigo-700' },
  AGRUPADA_BANCO: { corto: 'Agrupada', largo: 'Un comprobante contable = suma de varios movimientos del banco (4x1000, intereses, comisiones…)', clase: 'bg-amber-100 text-amber-800' },
  AGRUPADA_LIBROS: { corto: 'Agrupada', largo: 'Un movimiento del banco = suma de varios comprobantes contables', clase: 'bg-amber-100 text-amber-800' }
};

interface Bloque { saldo_inicial: number; neto: number; saldo_final: number; movimientos: number; saldos_consistentes: boolean }

interface Resultado {
  ejecutada_en: string;
  tolerancia: number;
  dias_holgura: number;
  banco?: string;
  archivo_auxiliar?: string;
  archivo_extracto?: string;
  libros: Bloque;
  extracto: Bloque;
  diferencia_saldos: number;
  cuadrado: boolean;
  conciliadas: Partida[];
  faltan_en_libros: Movimiento[];
  faltan_en_banco: Movimiento[];
  totales: { conciliado: number; pendiente_libros: number; pendiente_banco: number };
  advertencias: string[];
  por_tipo?: Record<string, number>;
}

interface Props {
  idEmpresa: number;
  nombreEmpresa?: string;
  onShowToast?: (message: string, type?: 'success' | 'info' | 'error') => void;
}

const PARAMETROS_DEFECTO = {
  nit_banco: '',
  cuenta_banco: '',
  tipo_comprobante: 'CC',
  consecutivo_inicial: '',
  cuenta_gasto_defecto: '53050501',
  cuenta_gmf: '51159501',
  cuenta_iva_descontable: '24080101',
  cuenta_ingresos_defecto: '13050501',
  cuenta_rendimientos: '42100501',
  un_solo_comprobante: false
};

const BANCOS = BANCOS_EXTRACTO;

export const ConciliacionView: React.FC<Props> = ({ idEmpresa, nombreEmpresa, onShowToast }) => {
  const avisar = (m: string, t: 'success' | 'info' | 'error' = 'success') => (onShowToast ? onShowToast(m, t) : alert(m));
  const [auxiliar, setAuxiliar] = useState<File | null>(null);
  const [extracto, setExtracto] = useState<File | null>(null);
  const [banco, setBanco] = useState('AUTO');
  const [tolerancia, setTolerancia] = useState('100');
  const [cruceInteligente, setCruceInteligente] = useState(true);
  const [holgura, setHolgura] = useState('0');
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [cargando, setCargando] = useState(false);
  const [tieneArchivos, setTieneArchivos] = useState({ aux: false, ext: false });
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [modal, setModal] = useState(false);
  const [param, setParam] = useState<Record<string, any>>(PARAMETROS_DEFECTO);
  const [errorModal, setErrorModal] = useState('');
  const [ocupado, setOcupado] = useState('');
  const [textoFiltro, setTextoFiltro] = useState('');
  const [fechaFiltro, setFechaFiltro] = useState('');
  const coincide = (fecha: string, ...textos: (string | number | undefined)[]) => {
    const t = textoFiltro.toLowerCase().trim();
    const okTexto = !t || textos.some(x => String(x ?? '').toLowerCase().includes(t));
    const okFecha = !fechaFiltro || (fecha || '').startsWith(fechaFiltro);
    return okTexto && okFecha;
  };

  useEffect(() => {
    setResultado(null);
    setSeleccion([]);
    apiJson<{ resultado: Resultado | null; parametros_ajuste: any; tiene_auxiliar: boolean; tiene_extracto: boolean }>(`/api/v1/empresas/${idEmpresa}/conciliacion`)
      .then(r => {
        setResultado(r.resultado);
        setTieneArchivos({ aux: r.tiene_auxiliar, ext: r.tiene_extracto });
        if (r.parametros_ajuste) setParam(p => ({ ...p, ...r.parametros_ajuste, consecutivo_inicial: '' }));
        if (r.resultado) setSeleccion(r.resultado.faltan_en_libros.map(m => m.id));
      })
      .catch(() => {});
  }, [idEmpresa]);

  const ejecutar = async () => {
    if ((!auxiliar && !tieneArchivos.aux) || (!extracto && !tieneArchivos.ext)) {
      avisar('Seleccione el auxiliar de libros y el extracto bancario.', 'error');
      return;
    }
    setCargando(true);
    try {
      const fd = new FormData();
      if (auxiliar) fd.append('auxiliar', auxiliar);
      if (extracto) fd.append('extracto', extracto);
      fd.append('tolerancia', tolerancia || '0');
      fd.append('dias_holgura', holgura || '0');
      fd.append('banco', banco);
      fd.append('cruce_por_valor', String(cruceInteligente));
      fd.append('cruce_agrupado', String(cruceInteligente));
      const r = await apiJson<Resultado & { archivado?: { ok: boolean; error?: string }[] }>(`/api/v1/empresas/${idEmpresa}/conciliacion/ejecutar`, { method: 'POST', body: fd });
      setResultado(r);
      setTieneArchivos({ aux: true, ext: true });
      setSeleccion(r.faltan_en_libros.map(m => m.id));
      setAuxiliar(null);
      setExtracto(null);
      const fallos = (r.archivado || []).filter(a => !a.ok).length;
      avisar(`Cruce ejecutado: ${r.conciliadas.length} conciliadas, ${r.faltan_en_libros.length} faltan en libros, ${r.faltan_en_banco.length} faltan en banco.${fallos ? ' Algunos archivos no se guardaron en la carpeta de la empresa.' : ''}`, fallos ? 'info' : 'success');
    } catch (err: any) {
      avisar(err.message, 'error');
    } finally {
      setCargando(false);
    }
  };

  const reporte = async () => {
    setOcupado('reporte');
    try {
      const r = await descargarArchivo(`/api/v1/empresas/${idEmpresa}/conciliacion/reporte-excel`, {}, 'Conciliacion.xlsx');
      avisar(`Reporte descargado${textoArchivado(r)}.`);
    } catch (err: any) {
      avisar(err.message, 'error');
    } finally {
      setOcupado('');
    }
  };

  const convertirPdf = async (archivo: File) => {
    setOcupado('pdf');
    try {
      const fd = new FormData();
      fd.append('extracto', archivo);
      const r = await descargarArchivo(`/api/v1/empresas/${idEmpresa}/conciliacion/extracto-a-excel`, { method: 'POST', body: fd }, 'extracto.xlsx');
      avisar(`Extracto convertido a Excel${textoArchivado(r)}.`);
    } catch (err: any) {
      avisar(err.message, 'error');
    } finally {
      setOcupado('');
    }
  };

  const requeridos = ['nit_banco', 'cuenta_banco', 'tipo_comprobante', 'consecutivo_inicial', 'cuenta_gasto_defecto', 'cuenta_gmf', 'cuenta_iva_descontable', 'cuenta_ingresos_defecto'];

  const generarPlano = async () => {
    const faltan = requeridos.filter(k => !String(param[k] ?? '').trim());
    if (faltan.length) {
      setErrorModal('Por favor diligencie todos los campos requeridos.');
      return;
    }
    setErrorModal('');
    setOcupado('plano');
    try {
      const r = await descargarArchivo(
        `/api/v1/empresas/${idEmpresa}/conciliacion/plano-ajustes`,
        { method: 'POST', body: JSON.stringify({ ids: seleccion, parametros: { ...param, consecutivo_inicial: Number(param.consecutivo_inicial) } }) },
        'Plano_Siigo_Ajustes.xlsx'
      );
      const final = Number(r.encabezados.get('X-TLM-Consecutivo-Final') || param.consecutivo_inicial);
      setParam({ ...param, consecutivo_inicial: String(final + 1) });
      setModal(false);
      avisar(`Plano de ajustes generado (${seleccion.length} movimientos)${textoArchivado(r)}.`);
    } catch (err: any) {
      setErrorModal(err.message);
    } finally {
      setOcupado('');
    }
  };

  const todasSel = resultado ? seleccion.length === resultado.faltan_en_libros.length && seleccion.length > 0 : false;
  const totalSel = useMemo(() => (resultado?.faltan_en_libros || []).filter(m => seleccion.includes(m.id)).reduce((s, m) => s + m.valor, 0), [resultado, seleccion]);

  const ArchivoInput: React.FC<{ etiqueta: string; archivo: File | null; previo?: string; accept: string; onChange: (f: File | null) => void }> = ({ etiqueta, archivo, previo, accept, onChange }) => (
    <div className="flex-1 min-w-[260px]">
      <div className="text-[10px] font-bold uppercase text-slate-500 mb-1">{etiqueta}</div>
      <label className="flex items-center gap-2 bg-[#f8f9fa] border border-slate-200 rounded-xl px-2 py-1.5 cursor-pointer hover:border-[#271a82]">
        <span className="px-2.5 py-1 rounded-lg bg-indigo-50 text-[#271a82] text-[11px] font-bold shrink-0">Seleccionar archivo</span>
        <span className="text-[11px] text-slate-600 truncate">{archivo?.name || (previo ? `${previo} (cargado)` : 'Ningún archivo seleccionado')}</span>
        <input type="file" accept={accept} className="hidden" onChange={e => { onChange(e.target.files?.[0] || null); e.target.value = ''; }} />
      </label>
    </div>
  );

  const Tarjeta: React.FC<{ titulo: string; icono: React.ReactNode; b: Bloque; color: string; etiqueta: string }> = ({ titulo, icono, b, color, etiqueta }) => (
    <div className={`bg-white rounded-2xl border border-slate-200 shadow-xs p-4 border-l-4 ${color}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-600">{icono}{titulo}</span>
        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-600">{etiqueta}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div><div className="text-[9px] uppercase text-slate-400">Saldo inicial</div><div className="text-xs font-bold text-slate-700">{formatoCOP(b.saldo_inicial)}</div></div>
        <div><div className="text-[9px] uppercase text-slate-400">Neto movs</div><div className={`text-xs font-bold ${b.neto < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatoCOP(b.neto)}</div></div>
        <div className="bg-slate-50 rounded-lg py-1"><div className="text-[9px] uppercase text-slate-400">Saldo final</div><div className="text-xs font-black text-slate-900">{formatoCOP(b.saldo_final)}</div></div>
      </div>
      {!b.saldos_consistentes && <div className="mt-2 text-[10px] text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Saldo inicial + neto ≠ saldo final: revise el archivo</div>}
    </div>
  );

  const valorCls = (v: number) => (v < 0 ? 'text-red-600' : 'text-emerald-700');

  return (
    <div className="space-y-5">
      {/* Entradas */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Scale className="w-5 h-5 text-[#271a82] mt-0.5" />
            <div>
              <h3 className="font-bold text-slate-800 text-base">Conciliación Bancaria Automática</h3>
              <p className="text-xs text-slate-500">Cruce determinístico por fecha y valor neto{nombreEmpresa ? ` · ${nombreEmpresa}` : ''}. Auxiliares, extractos y reportes se guardan en la carpeta de la empresa.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className={`flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-[#271a82] border border-indigo-200 text-xs font-bold cursor-pointer ${ocupado === 'pdf' ? 'opacity-60 pointer-events-none' : ''}`}>
              {ocupado === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Convertir PDF a Excel
              <input type="file" accept=".pdf,application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) convertirPdf(f); e.target.value = ''; }} />
            </label>
            <button onClick={reporte} disabled={!resultado || ocupado === 'reporte'} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-50">
              {ocupado === 'reporte' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />} Descargar Reporte Excel
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <ArchivoInput etiqueta="1. Auxiliar de libros (ERP / Siigo)" archivo={auxiliar} previo={tieneArchivos.aux ? resultado?.archivo_auxiliar : undefined} accept=".xlsx,.xls,.csv" onChange={setAuxiliar} />
          <div className="flex-1 min-w-[260px]">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-bold uppercase text-slate-500">2. Extracto bancario</span>
              <select value={banco} onChange={e => setBanco(e.target.value)} className="text-[10px] font-bold border border-slate-200 rounded px-1 py-0.5">
                {BANCOS.map(b => <option key={b} value={b}>{b === 'AUTO' ? 'Auto-detectar banco' : b}</option>)}
              </select>
            </div>
            <ArchivoInput etiqueta="" archivo={extracto} previo={tieneArchivos.ext ? resultado?.archivo_extracto : undefined} accept=".pdf,.xlsx,.xls,.csv,.txt" onChange={setExtracto} />
          </div>
          <label className="w-36">
            <span className="text-[10px] font-bold uppercase text-slate-500">Tolerancia ($ COP)</span>
            <input type="number" min={0} value={tolerancia} onChange={e => setTolerancia(e.target.value)} className="mt-1 w-full bg-[#f8f9fa] border border-slate-200 rounded-xl px-3 py-2 text-xs" />
          </label>
          <label className="w-28" title="0 = misma fecha exacta. Mayor a 0 permite cruzar partidas registradas con unos días de diferencia.">
            <span className="text-[10px] font-bold uppercase text-slate-500">Días holgura</span>
            <input type="number" min={0} max={10} value={holgura} onChange={e => setHolgura(e.target.value)} className="mt-1 w-full bg-[#f8f9fa] border border-slate-200 rounded-xl px-3 py-2 text-xs" />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 pb-2.5 cursor-pointer" title="Además de la misma fecha, cruza partidas con el mismo valor en otra fecha del periodo y comprobantes que agrupan varios movimientos del banco (4x1000, intereses, comisiones + IVA).">
            <input type="checkbox" checked={cruceInteligente} onChange={e => setCruceInteligente(e.target.checked)} /> Cruce inteligente
          </label>
          <button onClick={ejecutar} disabled={cargando} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#271a82] hover:bg-[#1c1343] text-white font-bold text-xs shadow-md cursor-pointer disabled:opacity-60">
            {cargando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4 text-[#fa9d1c]" />} Ejecutar Cruce
          </button>
        </div>
      </div>

      {!resultado ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center text-xs text-slate-500">
          Cargue el auxiliar de la cuenta bancaria exportado de Siigo (Excel) y el extracto del banco (PDF, Excel o CSV), y pulse <b>Ejecutar Cruce</b>.
        </div>
      ) : (
        <>
          {/* Resumen */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Tarjeta titulo="Auxiliar libros (ERP)" icono={<BookOpen className="w-3.5 h-3.5" />} b={resultado.libros} color="border-l-[#271a82]" etiqueta="Libros" />
            <Tarjeta titulo="Extracto bancario" icono={<Landmark className="w-3.5 h-3.5" />} b={resultado.extracto} color="border-l-emerald-500" etiqueta={resultado.banco || 'Banco'} />
            <div className={`bg-white rounded-2xl border border-slate-200 shadow-xs p-4 border-l-4 ${resultado.cuadrado ? 'border-l-emerald-500' : 'border-l-red-500'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold uppercase text-slate-600">Control descuadre</span>
                <span className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded ${resultado.cuadrado ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                  {resultado.cuadrado ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}{resultado.cuadrado ? 'Cuadrado' : 'Descuadrado'}
                </span>
              </div>
              <div className="flex items-end justify-between">
                <div><div className="text-[9px] uppercase text-slate-400">Diferencia saldos</div><div className="text-[11px] text-slate-500">Libros vs. extracto</div></div>
                <div className={`text-xl font-black ${resultado.cuadrado ? 'text-emerald-600' : 'text-red-600'}`}>{formatoCOP(resultado.diferencia_saldos)}</div>
              </div>
              <div className="text-[10px] text-slate-500 mt-2">Explicado por pendientes: {formatoCOP(resultado.totales.pendiente_banco - resultado.totales.pendiente_libros)}</div>
            </div>
          </div>

          {resultado.advertencias.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 space-y-1">
              {resultado.advertencias.map((a, i) => <div key={i} className="flex gap-1.5"><Info className="w-3.5 h-3.5 shrink-0" />{a}</div>)}
            </div>
          )}

          {resultado.faltan_en_libros.length === 0 && resultado.faltan_en_banco.length === 0 && (
            <div className="p-3 rounded-xl bg-emerald-600 text-white text-sm font-black text-center shadow-sm">✓ CONCILIACIÓN PERFECTA (100%): todas las partidas de libros y extracto coinciden.</div>
          )}

          <div className="flex flex-wrap items-center gap-2 bg-white rounded-2xl border border-slate-200 p-3">
            <span className="text-[10px] font-bold uppercase text-slate-400">Filtrar las tres listas:</span>
            <input value={textoFiltro} onChange={e => setTextoFiltro(e.target.value)} placeholder="Texto, comprobante, tercero o valor…" className="flex-1 min-w-[200px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs" />
            <input type="date" value={fechaFiltro} onChange={e => setFechaFiltro(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs" />
            <button onClick={() => { setTextoFiltro(''); setFechaFiltro(''); }} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold cursor-pointer">Limpiar</button>
          </div>

          {/* Tres listas */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="bg-white rounded-2xl border border-emerald-200 shadow-xs flex flex-col max-h-[560px]">
              <div className="px-4 py-3 bg-emerald-50 rounded-t-2xl flex items-center justify-between">
                <div><div className="text-xs font-bold text-emerald-800">1. Partidas conciliadas</div><div className="text-[10px] text-emerald-700">{resultado.por_tipo ? Object.entries(resultado.por_tipo).map(([t, n]) => `${n} ${(TIPO_CRUCE[t]?.corto || t).toLowerCase()}`).join(' · ') : 'Coincidencia libros = banco'}</div></div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-600 text-white text-[11px] font-black">{resultado.conciliadas.length}</span>
              </div>
              <div className="overflow-y-auto flex-1">
                <table className="w-full text-[11px]">
                  <thead className="text-slate-400 uppercase text-[9px] sticky top-0 bg-white"><tr><th className="text-left py-2 px-3">Fecha</th><th className="text-left">Comprobante / Detalle</th><th className="text-right px-3">Valor</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {resultado.conciliadas.filter(c => coincide(c.fecha, c.comprobante, c.detalle, c.descripcion_banco, c.valor)).map((c, i) => (
                      <tr key={i} title={`Banco${c.fecha_banco ? ` (${c.fecha_banco})` : ''}: ${c.descripcion_banco}${c.diferencia ? ` · diferencia ${formatoCOP(c.diferencia)}` : ''}${c.tipo ? `\n${TIPO_CRUCE[c.tipo]?.largo || ''}` : ''}`}>
                        <td className="py-1.5 px-3 pr-2 font-mono text-emerald-700 whitespace-nowrap">{c.fecha}{c.fecha_banco && c.fecha_banco !== c.fecha && <div className="text-[9px] text-slate-400">banco {c.fecha_banco}</div>}</td>
                        <td className="py-1.5 truncate max-w-[160px]">
                          {c.tipo && c.tipo !== 'EXACTA' && <span className={`text-[9px] font-bold rounded px-1 mr-1 ${TIPO_CRUCE[c.tipo]?.clase}`}>{TIPO_CRUCE[c.tipo]?.corto}{(c.ids_banco?.length || 1) > 1 ? ` ×${c.ids_banco!.length}` : (c.ids_libro?.length || 1) > 1 ? ` ×${c.ids_libro!.length}` : ''}</span>}
                          <span className="font-mono text-[10px] bg-slate-100 rounded px-1 mr-1">{c.comprobante || '—'}</span>{c.detalle}
                        </td>
                        <td className={`py-1.5 px-3 text-right font-semibold whitespace-nowrap ${valorCls(c.valor)}`}>{formatoCOP(c.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 bg-emerald-50 rounded-b-2xl flex justify-between text-xs font-bold text-emerald-800"><span>Total conciliado</span><span>{formatoCOP(resultado.totales.conciliado)}</span></div>
            </div>

            <div className="bg-white rounded-2xl border border-red-200 shadow-xs flex flex-col max-h-[560px]">
              <div className="px-4 py-3 bg-red-50 rounded-t-2xl flex items-center justify-between">
                <div><div className="text-xs font-bold text-red-800">2. Faltan en libros</div><div className="text-[10px] text-red-700">En extracto, pendientes de contabilizar</div></div>
                <span className="px-2 py-0.5 rounded-full bg-red-600 text-white text-[11px] font-black">{resultado.faltan_en_libros.length}</span>
              </div>
              <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100">
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-700">{seleccion.length} seleccionadas · {formatoCOP(totalSel)}</span>
                <button onClick={() => { setErrorModal(''); setModal(true); }} disabled={!seleccion.length} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold cursor-pointer disabled:opacity-50">
                  <FilePlus2 className="w-3.5 h-3.5" /> Crear archivo plano
                </button>
              </div>
              <div className="overflow-y-auto flex-1">
                <table className="w-full text-[11px]">
                  <thead className="text-slate-400 uppercase text-[9px] sticky top-0 bg-white">
                    <tr>
                      <th className="py-2 px-3 w-6"><input type="checkbox" checked={todasSel} onChange={() => setSeleccion(todasSel ? [] : resultado.faltan_en_libros.map(m => m.id))} /></th>
                      <th className="text-left">Fecha</th><th className="text-left">Comprobante / Descripción</th><th className="text-right px-3">Valor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {resultado.faltan_en_libros.filter(m => coincide(m.fecha, m.descripcion, m.comprobante, m.tercero, m.valor)).map(m => (
                      <tr key={m.id}>
                        <td className="py-1.5 px-3"><input type="checkbox" checked={seleccion.includes(m.id)} onChange={() => setSeleccion(seleccion.includes(m.id) ? seleccion.filter(x => x !== m.id) : [...seleccion, m.id])} /></td>
                        <td className="py-1.5 pr-2 font-mono text-red-700 whitespace-nowrap">{m.fecha}</td>
                        <td className="py-1.5 truncate max-w-[170px]" title={m.descripcion}>{m.descripcion}</td>
                        <td className={`py-1.5 px-3 text-right font-semibold whitespace-nowrap ${valorCls(m.valor)}`}>{formatoCOP(m.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 bg-red-50 rounded-b-2xl flex justify-between text-xs font-bold text-red-800"><span>Total pendiente libros</span><span>{formatoCOP(resultado.totales.pendiente_libros)}</span></div>
            </div>

            <div className="bg-white rounded-2xl border border-amber-200 shadow-xs flex flex-col max-h-[560px]">
              <div className="px-4 py-3 bg-amber-50 rounded-t-2xl flex items-center justify-between">
                <div><div className="text-xs font-bold text-amber-800">3. Faltan en banco</div><div className="text-[10px] text-amber-700">En libros, pendientes de cobro/pago</div></div>
                <span className="px-2 py-0.5 rounded-full bg-amber-500 text-white text-[11px] font-black">{resultado.faltan_en_banco.length}</span>
              </div>
              <div className="overflow-y-auto flex-1">
                <table className="w-full text-[11px]">
                  <thead className="text-slate-400 uppercase text-[9px] sticky top-0 bg-white"><tr><th className="text-left py-2 px-3">Fecha</th><th className="text-left">Comprobante / Descripción</th><th className="text-right px-3">Valor</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {resultado.faltan_en_banco.filter(m => coincide(m.fecha, m.descripcion, m.comprobante, m.tercero, m.valor)).map(m => (
                      <tr key={m.id}>
                        <td className="py-1.5 px-3 font-mono text-amber-700 whitespace-nowrap">{m.fecha}</td>
                        <td className="py-1.5 truncate max-w-[170px]" title={m.descripcion}><span className="font-mono text-[10px] bg-amber-100 rounded px-1 mr-1">{m.comprobante || '—'}</span>{m.tercero || m.descripcion}</td>
                        <td className={`py-1.5 px-3 text-right font-semibold whitespace-nowrap ${valorCls(m.valor)}`}>{formatoCOP(m.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 bg-amber-50 rounded-b-2xl flex justify-between text-xs font-bold text-amber-800"><span>Total pendiente banco</span><span>{formatoCOP(resultado.totales.pendiente_banco)}</span></div>
            </div>
          </div>
        </>
      )}

      {/* Modal Generar Ajuste Contable */}
      {modal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 bg-[#271a82] rounded-t-2xl text-white">
              <div className="flex items-center gap-2 text-sm font-bold"><FilePlus2 className="w-4 h-4 text-[#fa9d1c]" /> Generar Ajuste Contable</div>
              <button onClick={() => setModal(false)} className="cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[11px] text-slate-500">Cuentas de partida doble para el comprobante de ajuste de Siigo Nube ({seleccion.length} movimientos). Las salidas de dinero van al gasto y las entradas a la cuenta de ingresos; el motor detecta 4×1000 (incluidos reintegros) e IVA por la descripción.</p>
              <div className="grid grid-cols-2 gap-3">
                {([
                  ['nit_banco', 'NIT banco (tercero)', 'Ej: 860034313'],
                  ['cuenta_banco', 'Cuenta del banco', 'Ej: 11100505'],
                  ['tipo_comprobante', 'Tipo comprobante', 'CC'],
                  ['consecutivo_inicial', 'Consecutivo inicial', 'Ej: 1520']
                ] as const).map(([k, l, ph]) => (
                  <label key={k} className="block">
                    <span className="text-[10px] font-bold uppercase text-slate-500">{l}</span>
                    <input value={param[k] ?? ''} placeholder={ph} onChange={e => setParam({ ...param, [k]: e.target.value })} className={`mt-1 w-full border rounded-lg px-2.5 py-1.5 text-xs ${errorModal && !String(param[k] ?? '').trim() ? 'border-red-400 bg-red-50' : 'border-slate-200'}`} />
                  </label>
                ))}
              </div>
              <label className="block">
                <span className="text-[10px] font-bold uppercase text-slate-500">Cuenta gasto por defecto (comisiones / otros)</span>
                <input value={param.cuenta_gasto_defecto} onChange={e => setParam({ ...param, cuenta_gasto_defecto: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs" />
              </label>
              <label className="block">
                <span className="text-[10px] font-bold uppercase text-slate-500">Cuenta ingresos por defecto (abonos / consignaciones)</span>
                <input value={param.cuenta_ingresos_defecto} onChange={e => setParam({ ...param, cuenta_ingresos_defecto: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs" />
              </label>
              <div className="grid grid-cols-3 gap-3 pt-2 border-t border-slate-100">
                <label className="block"><span className="text-[10px] font-bold uppercase text-red-600">Cuenta GMF (4×1000)</span><input value={param.cuenta_gmf} onChange={e => setParam({ ...param, cuenta_gmf: e.target.value })} className="mt-1 w-full border border-red-200 bg-red-50 rounded-lg px-2 py-1.5 text-xs" /></label>
                <label className="block"><span className="text-[10px] font-bold uppercase text-indigo-600">IVA descontable</span><input value={param.cuenta_iva_descontable} onChange={e => setParam({ ...param, cuenta_iva_descontable: e.target.value })} className="mt-1 w-full border border-indigo-200 bg-indigo-50 rounded-lg px-2 py-1.5 text-xs" /></label>
                <label className="block"><span className="text-[10px] font-bold uppercase text-emerald-600">Rendimientos</span><input value={param.cuenta_rendimientos} onChange={e => setParam({ ...param, cuenta_rendimientos: e.target.value })} className="mt-1 w-full border border-emerald-200 bg-emerald-50 rounded-lg px-2 py-1.5 text-xs" /></label>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={Boolean(param.un_solo_comprobante)} onChange={e => setParam({ ...param, un_solo_comprobante: e.target.checked })} /> Todos los ajustes en un solo comprobante</label>
              {errorModal && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-[11px] text-red-700">{errorModal}</div>}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
              <button onClick={() => setModal(false)} className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold cursor-pointer">Cancelar</button>
              <button onClick={generarPlano} disabled={ocupado === 'plano'} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-60">
                {ocupado === 'plano' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />} Descargar Excel Siigo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
