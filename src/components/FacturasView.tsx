import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Factura, CuentaPUC, Empresa } from '../types/index.ts';
import {
  UploadCloud, Search, FileCheck2, Trash2, Send, FileSpreadsheet, Eye, Sparkles, CheckSquare, Square,
  ShieldCheck, FolderDown, Loader2, FileDown, FileText, Settings2, X, Copy, ChevronDown, CheckCircle2,
  RotateCcw, RefreshCw, KeyRound, AlertTriangle, Download, Eraser
} from 'lucide-react';
import { apiJson, descargarArchivo, textoArchivado } from '../lib/api.ts';
import { CATALOGO_RTEFTE, CATALOGO_RTEICA, CATALOGO_RTEIVA } from '../shared/catalogosDian.ts';

export interface FiltrosPeriodo {
  desde: string;
  hasta: string;
  tipo: 'TODOS' | 'VENTA' | 'COMPRA';
}

interface OpcionImpuesto { id: string | number; name: string; percentage: number }
interface CatalogosSiigo {
  configurado: boolean;
  conectado: boolean;
  fuente: 'SIIGO' | 'CONTINGENCIA_DIAN';
  medios_pago: { id: number; name: string }[];
  retefuente: OpcionImpuesto[];
  reteica: OpcionImpuesto[];
  reteiva: OpcionImpuesto[];
  document_id: number;
  error?: string;
}

interface FacturasViewProps {
  facturas: Factura[];
  cuentasPUC: CuentaPUC[];
  activeEmpresa?: Empresa | null;
  esAdmin?: boolean;
  filtros?: FiltrosPeriodo;
  onFiltrosChange?: (f: FiltrosPeriodo) => void;
  onUploadXml: (files: FileList) => void;
  onSeedDemo: () => void;
  onImportFromDrive?: () => void;
  onUpdateFactura: (id: number, field: string, value: any) => void;
  onDeleteFactura: (id: number) => void;
  onBulkDelete: (ids: number[]) => void;
  onClearAll?: () => void;
  onInspectCufe: (factura: Factura) => void;
  onOpenSiigoPush?: (facturas: Factura[]) => void;
  onRefresh?: () => void;
  onShowToast?: (message: string, type?: 'success' | 'info' | 'error') => void;
  isUploading?: boolean;
  onUploadXmlWithProgress?: (files: FileList) => Promise<{ archivos_procesados: number; xmls_extraidos: number; facturas_creadas: number; facturas_duplicadas?: number; facturas_nuevas?: number; pdfs_originales?: number }>;
}

const CUENTAS_AVANZADAS: { clave: string; etiqueta: string; defecto: string }[] = [
  { clave: 'clientes', etiqueta: 'Clientes (CxC)', defecto: '13050501' },
  { clave: 'proveedores', etiqueta: 'Proveedores (CxP)', defecto: '22050101' },
  { clave: 'iva_generado', etiqueta: 'IVA generado (ventas)', defecto: '24080105' },
  { clave: 'iva_descontable', etiqueta: 'IVA descontable (compras)', defecto: '24080101' },
  { clave: 'retefuente_por_pagar', etiqueta: 'ReteFuente por pagar', defecto: '23652501' },
  { clave: 'reteica_por_pagar', etiqueta: 'ReteICA por pagar', defecto: '23680501' },
  { clave: 'reteiva_por_pagar', etiqueta: 'ReteIVA por pagar', defecto: '23670501' },
  { clave: 'anticipo_retefuente', etiqueta: 'Anticipo ReteFuente (ventas)', defecto: '13551501' }
];

const CATALOGO_LOCAL: CatalogosSiigo = {
  configurado: false,
  conectado: false,
  fuente: 'CONTINGENCIA_DIAN',
  medios_pago: [],
  retefuente: CATALOGO_RTEFTE.map(t => ({ id: t.id, name: t.nombre, percentage: t.porcentaje })),
  reteica: CATALOGO_RTEICA.map(t => ({ id: t.id, name: t.nombre, percentage: t.porcentaje })),
  reteiva: CATALOGO_RTEIVA.map(t => ({ id: t.id, name: t.nombre, percentage: t.porcentaje })),
  document_id: 24
};

const leerLocal = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const guardarLocal = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
const formatCOP = (num: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(num || 0);
/** Siigo expresa algunas tarifas de ICA en % (0.966) y otras en ‰ (9.66) */
const icaPorMil = (p: number) => (p > 0 && p < 2 ? Math.round(p * 1000) / 100 : p);

export const FacturasView: React.FC<FacturasViewProps> = ({
  facturas, cuentasPUC, activeEmpresa, esAdmin = false, filtros: filtrosProp, onFiltrosChange,
  onUploadXml, onSeedDemo, onImportFromDrive, onUpdateFactura, onDeleteFactura, onBulkDelete, onClearAll,
  onInspectCufe, onRefresh, onShowToast, isUploading = false, onUploadXmlWithProgress
}) => {
  const alternarLineas = (idFactura: number) =>
    setLineasAbiertas(prev => (prev.includes(idFactura) ? prev.filter(x => x !== idFactura) : [...prev, idFactura]));

  // Guarda cuenta o centro de costo de una sola línea
  const guardarLinea = async (f: Factura, linea: number, cambios: Record<string, unknown>) => {
    try {
      await apiJson(`/api/v1/facturas/${f.id_factura}/lineas/${linea}`, { method: 'PATCH', body: JSON.stringify(cambios) });
      onRefresh?.();
    } catch (err: any) { avisar(err.message, 'error'); }
  };

  const avisar = (m: string, t: 'success' | 'info' | 'error' = 'success') => (onShowToast ? onShowToast(m, t) : alert(m));
  const idEmpresa = activeEmpresa?.id_empresa || 1;

  useEffect(() => {
    apiJson<any>(`/api/v1/empresas/${idEmpresa}/siigo/centros-costo`)
      .then(r => setCentrosCC({ conectado: !!r.conectado, centros: r.centros || [], mensaje: r.mensaje || null }))
      .catch(() => setCentrosCC({ conectado: false, centros: [], mensaje: 'No se pudieron cargar los centros de costo.' }));
  }, [idEmpresa]);


  // ---------------- Filtros ----------------
  const [filtrosLocal, setFiltrosLocal] = useState<FiltrosPeriodo>({ desde: '', hasta: '', tipo: 'TODOS' });
  const filtros = filtrosProp || filtrosLocal;
  const setFiltros = (f: FiltrosPeriodo) => (onFiltrosChange ? onFiltrosChange(f) : setFiltrosLocal(f));
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('TODOS');
  const [casillaFilter, setCasillaFilter] = useState('TODOS');
  const [tamPagina, setTamPagina] = useState<number | 'all'>(25);
  const [pagina, setPagina] = useState(1);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // Líneas desplegadas por factura y centros de costo de Siigo de la empresa activa
  const [lineasAbiertas, setLineasAbiertas] = useState<number[]>([]);
  const [centrosCC, setCentrosCC] = useState<{ conectado: boolean; centros: { id: number; codigo: string; nombre: string }[]; mensaje: string | null }>({ conectado: false, centros: [], mensaje: null });

  // ---------------- Estado de procesos ----------------
  const [ocupado, setOcupado] = useState<'' | 'auditoria' | 'erp' | 'pdf' | 'masivo' | 'siigo'>('');
  const [uploading, setUploading] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const [resultadoCargue, setResultadoCargue] = useState<{ procesados: number; nuevas: number; duplicadas: number; pdfs: number } | null>(null);
  const [menuExportar, setMenuExportar] = useState(false);
  const inputArchivos = useRef<HTMLInputElement>(null);

  // ---------------- Siigo ----------------
  const [catalogos, setCatalogos] = useState<CatalogosSiigo>(CATALOGO_LOCAL);
  const [modalSiigo, setModalSiigo] = useState(false);
  const [siigoUser, setSiigoUser] = useState('');
  const [siigoKey, setSiigoKey] = useState('');
  const [siigoDoc, setSiigoDoc] = useState('24');
  const [siigoEstado, setSiigoEstado] = useState<{ ok: boolean; texto: string } | null>(null);
  const [informeSiigo, setInformeSiigo] = useState<{ exitosas: number; fallidas: number; omitidas: number; reporte_detalle: any[]; informe_xlsx_b64: string } | null>(null);

  // ---------------- Lote ----------------
  const [bancoLote, setBancoLote] = useState('');
  const [rteLote, setRteLote] = useState('');
  const [icaLote, setIcaLote] = useState('');
  const [ivaLote, setIvaLote] = useState('');

  // ---------------- Visor PDF y ERP ----------------
  const [pdfFactura, setPdfFactura] = useState<Factura | null>(null);
  const [conPdfOriginal, setConPdfOriginal] = useState<Set<number>>(new Set());
  const [erpAbierto, setErpAbierto] = useState(false);
  const [erpTipo, setErpTipo] = useState(() => leerLocal(`tlm_erp_tipo_${idEmpresa}`, '11'));
  const [erpPrefijo, setErpPrefijo] = useState('');
  const [erpConsecutivo, setErpConsecutivo] = useState(() => leerLocal(`tlm_erp_consec_${idEmpresa}`, '1'));
  const [erpSoloAuditadas, setErpSoloAuditadas] = useState(false);
  const [erpAvanzado, setErpAvanzado] = useState(false);
  const [erpCuentas, setErpCuentas] = useState<Record<string, string>>(() => { try { return JSON.parse(leerLocal(`tlm_erp_cuentas_${idEmpresa}`, '{}')); } catch { return {}; } });

  const cargarCatalogos = async (refrescar = false) => {
    try {
      const c = await apiJson<CatalogosSiigo>(`/api/v1/empresas/${idEmpresa}/siigo/catalogos${refrescar ? '?refrescar=1' : ''}`);
      setCatalogos({ ...CATALOGO_LOCAL, ...c });
    } catch {
      setCatalogos(CATALOGO_LOCAL);
    }
  };

  useEffect(() => { cargarCatalogos(); setSelectedIds([]); setPagina(1); }, [idEmpresa]);
  useEffect(() => {
    apiJson<{ ids: number[] }>(`/api/v1/empresas/${idEmpresa}/facturas/soportes-originales`)
      .then(r => setConPdfOriginal(new Set(r.ids))).catch(() => setConPdfOriginal(new Set()));
  }, [idEmpresa, facturas]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPdfFactura(null); setErpAbierto(false); setModalSiigo(false); setMenuExportar(false); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);

  // ---------------- Datos filtrados y paginados ----------------
  const filteredFacturas = useMemo(() => facturas.filter(f => {
    const s = searchTerm.toLowerCase().trim();
    const okBusqueda = !s ||
      f.factura_num.toLowerCase().includes(s) ||
      f.proveedor.toLowerCase().includes(s) ||
      f.nit_tercero.includes(s) ||
      f.cuenta_gasto.includes(s) ||
      (f.descripcion_item || '').toLowerCase().includes(s) ||
      (f.items || []).some(i => i.descripcion_item.toLowerCase().includes(s));
    const okEstado = statusFilter === 'TODOS' || f.estado_revision === statusFilter;
    const okCasilla = casillaFilter === 'TODOS' || String(f.casilla_350) === casillaFilter;
    const okTipo = filtros.tipo === 'TODOS' || (f.tipo_operacion || 'COMPRA') === filtros.tipo;
    const okDesde = !filtros.desde || (f.fecha || '') >= filtros.desde;
    const okHasta = !filtros.hasta || (f.fecha || '') <= filtros.hasta;
    return okBusqueda && okEstado && okCasilla && okTipo && okDesde && okHasta;
  }), [facturas, searchTerm, statusFilter, casillaFilter, filtros]);

  const totalPaginas = tamPagina === 'all' ? 1 : Math.max(1, Math.ceil(filteredFacturas.length / tamPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const inicio = tamPagina === 'all' ? 0 : (paginaSegura - 1) * tamPagina;
  const fin = tamPagina === 'all' ? filteredFacturas.length : Math.min(inicio + tamPagina, filteredFacturas.length);
  const visibles = filteredFacturas.slice(inicio, fin);

  const facturasUnicas = useMemo(() => new Set(facturas.map(f => f.cufe_hash)).size, [facturas]);
  const lineasContables = useMemo(() => facturas.reduce((s, f) => s + (f.items?.length || 1), 0), [facturas]);

  const filtrosActivos = Boolean(searchTerm || statusFilter !== 'TODOS' || casillaFilter !== 'TODOS' || filtros.tipo !== 'TODOS' || filtros.desde || filtros.hasta);
  const idsObjetivo = () => (selectedIds.length ? selectedIds : filteredFacturas.map(f => f.id_factura));
  const consultaIds = () => (selectedIds.length || filtrosActivos ? `?ids=${idsObjetivo().join(',')}` : '');
  const objetivoTexto = selectedIds.length ? `${selectedIds.length} seleccionadas` : filtrosActivos ? `${filteredFacturas.length} filtradas` : 'todas';

  const toggleSelectAll = () => {
    const idsPagina = visibles.map(f => f.id_factura);
    const todas = idsPagina.every(id => selectedIds.includes(id));
    setSelectedIds(todas ? selectedIds.filter(id => !idsPagina.includes(id)) : [...new Set([...selectedIds, ...idsPagina])]);
  };
  const toggleSelectOne = (id: number) => setSelectedIds(selectedIds.includes(id) ? selectedIds.filter(i => i !== id) : [...selectedIds, id]);

  // ---------------- Cargue ----------------
  const subirArchivos = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setResultadoCargue(null);
    try {
      if (onUploadXmlWithProgress) {
        const r = await onUploadXmlWithProgress(files);
        setResultadoCargue({ procesados: r.facturas_creadas, nuevas: r.facturas_nuevas ?? r.facturas_creadas, duplicadas: r.facturas_duplicadas ?? 0, pdfs: r.pdfs_originales ?? 0 });
      } else {
        onUploadXml(files);
      }
    } catch {
      /* el aviso lo muestra App */
    } finally {
      setUploading(false);
    }
  };

  // ---------------- Operaciones por lote ----------------
  const masivo = async (ids: number[], campos: Record<string, unknown>, descripcion?: string) => {
    if (!ids.length) { avisar('Marque al menos una factura en la tabla.', 'info'); return false; }
    setOcupado('masivo');
    try {
      const r = await apiJson<{ mensaje: string }>(`/api/v1/empresas/${idEmpresa}/facturas/masivo`, { method: 'PATCH', body: JSON.stringify({ ids, campos }) });
      if (descripcion) avisar(`${descripcion}: ${r.mensaje}`);
      onRefresh?.();
      return true;
    } catch (err: any) {
      avisar(err.message, 'error');
      return false;
    } finally {
      setOcupado('');
    }
  };

  const camposRetencion = (tipo: 'fte' | 'ica' | 'iva', valor: string): Record<string, unknown> => {
    const lista = tipo === 'fte' ? catalogos.retefuente : tipo === 'ica' ? catalogos.reteica : catalogos.reteiva;
    const opcion = lista.find(o => String(o.id) === valor);
    const pct = opcion ? Number(opcion.percentage) : 0;
    const idSiigo = catalogos.conectado && opcion && !String(opcion.id).startsWith('porc_') ? Number(opcion.id) : null;
    if (tipo === 'fte') return { retencion_porc: pct, id_retencion: idSiigo };
    if (tipo === 'ica') return { reteica_tarifa: icaPorMil(pct), id_reteica: idSiigo };
    return { reteiva_porc: pct, id_reteiva: idSiigo };
  };

  const valorRetencion = (f: Factura, tipo: 'fte' | 'ica' | 'iva') => {
    const lista = tipo === 'fte' ? catalogos.retefuente : tipo === 'ica' ? catalogos.reteica : catalogos.reteiva;
    const idGuardado = tipo === 'fte' ? f.id_retencion : tipo === 'ica' ? f.id_reteica : f.id_reteiva;
    if (idGuardado && lista.some(o => String(o.id) === String(idGuardado))) return String(idGuardado);
    const pct = tipo === 'fte' ? f.retencion_porc : tipo === 'ica' ? f.reteica_tarifa || 0 : f.reteiva_porc || 0;
    const igual = lista.find(o => Math.abs((tipo === 'ica' ? icaPorMil(Number(o.percentage)) : Number(o.percentage)) - Number(pct || 0)) < 0.05);
    return igual ? String(igual.id) : '';
  };

  const copiarCuenta = async (f: Factura) => {
    const input = document.getElementById(`cta-${f.id_factura}`) as HTMLInputElement | null;
    const cuenta = (input?.value || '').replace(/[^\d]/g, '');
    if (!cuenta) return;
    const objetivo = filtrosActivos ? filteredFacturas : facturas.filter(x => x.nit_tercero === f.nit_tercero);
    const texto = filtrosActivos
      ? `¿Aplicar la cuenta ${cuenta} a las ${objetivo.length} facturas filtradas y marcarlas como auditadas?`
      : `¿Aplicar la cuenta ${cuenta} a las ${objetivo.length} facturas de ${f.proveedor} (NIT ${f.nit_tercero}) y marcarlas como auditadas?`;
    if (!window.confirm(texto)) return;
    await masivo(objetivo.map(x => x.id_factura), { cuenta_gasto: cuenta, estado_revision: 'AUDITADA' }, `Cuenta ${cuenta}`);
  };

  // ---------------- Exportaciones ----------------
  const descargarAuditoria = async () => {
    setMenuExportar(false);
    setOcupado('auditoria');
    try {
      const r = await descargarArchivo(`/api/v1/empresas/${idEmpresa}/facturas/auditoria-excel${consultaIds()}`, {}, 'Auditoria_TLM.xlsx');
      avisar(`Auditoría generada${textoArchivado(r)}.`, r.archivado === 'error' ? 'info' : 'success');
    } catch (err: any) { avisar(err.message, 'error'); } finally { setOcupado(''); }
  };

  const descargarSoportes = async () => {
    setMenuExportar(false);
    setOcupado('pdf');
    try {
      const r = await descargarArchivo(`/api/v1/empresas/${idEmpresa}/facturas/soportes-pdf${consultaIds()}`, {}, 'Soportes_PDF.zip');
      const originales = Number(r.encabezados.get('X-TLM-Pdf-Originales') || 0);
      const generados = Number(r.encabezados.get('X-TLM-Pdf-Generados') || 0);
      avisar(`Soportes PDF descargados: ${originales} PDF original(es) del .zip${generados ? ` y ${generados} representación(es) generada(s) desde el XML (esas facturas no traían PDF)` : ''}${textoArchivado(r)}.`, r.archivado === 'error' || generados ? 'info' : 'success');
    } catch (err: any) { avisar(err.message, 'error'); } finally { setOcupado(''); }
  };

  const exportarErp = async () => {
    if (!erpTipo.trim() || !erpConsecutivo.trim()) { avisar('Indique el tipo de comprobante y el consecutivo inicial.', 'error'); return; }
    setOcupado('erp');
    try {
      const cuentas = Object.fromEntries(Object.entries(erpCuentas).filter(([, v]) => v && v.trim()));
      const r = await descargarArchivo(`/api/v1/empresas/${idEmpresa}/facturas/exportar-erp`, {
        method: 'POST',
        body: JSON.stringify({ tipo_comprobante: erpTipo.trim(), prefijo: erpPrefijo.trim(), consecutivo_inicial: Number(erpConsecutivo), ids: selectedIds.length || filtrosActivos ? idsObjetivo() : undefined, solo_auditadas: erpSoloAuditadas, cuentas })
      }, 'Comprobantes_Contables.xlsx');
      const final = Number(r.encabezados.get('X-TLM-Consecutivo-Final') || erpConsecutivo);
      guardarLocal(`tlm_erp_tipo_${idEmpresa}`, erpTipo.trim());
      guardarLocal(`tlm_erp_consec_${idEmpresa}`, String(final + 1));
      guardarLocal(`tlm_erp_cuentas_${idEmpresa}`, JSON.stringify(erpCuentas));
      setErpConsecutivo(String(final + 1));
      setErpAbierto(false);
      avisar(`Archivo ERP generado (consecutivos ${erpConsecutivo} a ${final})${textoArchivado(r)}.`, r.archivado === 'error' ? 'info' : 'success');
    } catch (err: any) { avisar(err.message, 'error'); } finally { setOcupado(''); }
  };

  // ---------------- Siigo ----------------
  const abrirConfigSiigo = async () => {
    setSiigoEstado(null);
    setSiigoKey('');
    try {
      const c = await apiJson<any>(`/api/v1/empresas/${idEmpresa}/siigo-config`);
      setSiigoUser(c.siigo_username || '');
      setSiigoDoc(String(c.siigo_document_id || 24));
      if (c.has_credentials) setSiigoEstado({ ok: true, texto: 'Esta empresa ya tiene credenciales de Siigo. Deje la llave vacía para conservarla.' });
    } catch {}
    setModalSiigo(true);
  };

  const guardarConfigSiigo = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado('siigo');
    setSiigoEstado(null);
    try {
      const r = await apiJson<{ mensaje: string }>(`/api/v1/empresas/${idEmpresa}/siigo-config`, {
        method: 'PUT',
        body: JSON.stringify({ siigo_username: siigoUser.trim(), siigo_access_key: siigoKey.trim(), siigo_document_id: Number(siigoDoc) || 24 })
      });
      setSiigoEstado({ ok: true, texto: r.mensaje });
      await cargarCatalogos(true);
      onRefresh?.();
      setTimeout(() => setModalSiigo(false), 1200);
    } catch (err: any) {
      setSiigoEstado({ ok: false, texto: err.message });
    } finally { setOcupado(''); }
  };

  const enviarSiigo = async () => {
    if (!catalogos.configurado) { abrirConfigSiigo(); return; }
    if (!selectedIds.length) { avisar('Seleccione las facturas de compra que desea enviar a Siigo.', 'info'); return; }
    setOcupado('siigo');
    try {
      const r = await apiJson<any>(`/api/v1/empresas/${idEmpresa}/siigo/enviar`, { method: 'POST', body: JSON.stringify({ ids: selectedIds }) });
      setInformeSiigo(r);
      setSelectedIds([]);
      onRefresh?.();
    } catch (err: any) { avisar(err.message, 'error'); } finally { setOcupado(''); }
  };

  const descargarInformeSiigo = () => {
    if (!informeSiigo) return;
    const bytes = Uint8Array.from(atob(informeSiigo.informe_xlsx_b64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `Informe_Transmision_Siigo_${activeEmpresa?.nit || idEmpresa}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  const opciones = (lista: OpcionImpuesto[], unidad: '%' | '‰') =>
    lista.map(o => <option key={String(o.id)} value={String(o.id)}>{String(o.id).startsWith('porc_') ? o.name : `${o.name} (${o.percentage}${unidad})`}</option>);

  const botonSiigoActivo = catalogos.configurado;

  return (
    <div className="space-y-5">
      <datalist id="lista-puc">
        {cuentasPUC.map(c => <option key={`${c.id_puc}-${c.cuenta}`} value={c.cuenta}>{c.nombre}</option>)}
      </datalist>

      {/* Carga automática */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-4">
        <div
          onDragOver={e => { e.preventDefault(); setArrastrando(true); }}
          onDragLeave={() => setArrastrando(false)}
          onDrop={e => { e.preventDefault(); setArrastrando(false); subirArchivos(e.dataTransfer.files); }}
          className={`bg-white rounded-2xl p-5 border-2 border-dashed shadow-xs flex flex-col items-center text-center gap-3 transition ${arrastrando ? 'border-[#271a82] bg-indigo-50/60' : 'border-slate-300'}`}
        >
          <UploadCloud className="w-6 h-6 text-[#271a82]" />
          <div>
            <h3 className="font-bold text-slate-800 text-base">Carga Automática de Comprobantes</h3>
            <p className="text-xs text-slate-500">Soporta paquetes .ZIP de la DIAN (XML + PDF) o archivos XML UBL 2.1 con su PDF. <button onClick={() => inputArchivos.current?.click()} className="font-bold text-[#271a82] hover:underline cursor-pointer">Arrastra tus archivos aquí o haz clic para explorar</button>.</p>
            <input ref={inputArchivos} type="file" multiple accept=".xml,.zip,.pdf,application/zip,text/xml,application/xml,application/pdf" className="hidden" onChange={e => { subirArchivos(e.target.files); e.target.value = ''; }} />
          </div>
          <div className="flex flex-wrap justify-center items-center gap-2">
            <button onClick={() => inputArchivos.current?.click()} disabled={uploading || isUploading} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#271a82] hover:bg-[#1c1343] text-white font-bold text-xs shadow-md cursor-pointer disabled:opacity-60">
              {uploading ? <><Loader2 className="w-4 h-4 animate-spin text-[#fa9d1c]" /> Procesando ETL…</> : <><UploadCloud className="w-4 h-4 text-[#fa9d1c]" /> Subir Archivos</>}
            </button>
            <button onClick={abrirConfigSiigo} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-[#271a82] border border-indigo-200 font-bold text-xs cursor-pointer">
              <KeyRound className="w-4 h-4" /> Config. Siigo
            </button>
            <div className="relative">
              <button onClick={() => setMenuExportar(!menuExportar)} disabled={!!ocupado} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#e07b16] hover:bg-[#c96a0f] text-white font-bold text-xs shadow-sm cursor-pointer disabled:opacity-60">
                {ocupado === 'auditoria' || ocupado === 'pdf' || ocupado === 'erp' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                {ocupado === 'pdf' ? `Comprimiendo (${idsObjetivo().length} docs)…` : 'Exportar'} <ChevronDown className="w-3.5 h-3.5" />
              </button>
              {menuExportar && (
                <div className="absolute z-30 mt-1 left-0 w-56 bg-white rounded-xl shadow-xl border border-slate-200 p-1 text-left">
                  <button onClick={descargarAuditoria} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"><FileSpreadsheet className="w-4 h-4 text-[#e07b16]" /> Auditoría Excel</button>
                  <button onClick={() => { setMenuExportar(false); setErpAbierto(true); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"><FileDown className="w-4 h-4 text-emerald-600" /> Plantilla ERP (Siigo)</button>
                  <button onClick={descargarSoportes} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"><FileText className="w-4 h-4 text-purple-600" /> Soportes PDF (ZIP)</button>
                  <div className="px-3 pt-1 pb-1.5 text-[10px] text-slate-400">Aplica a: {objetivoTexto}</div>
                </div>
              )}
            </div>
            <button
              onClick={enviarSiigo}
              disabled={ocupado === 'siigo'}
              title={botonSiigoActivo ? 'Enviar las facturas de compra seleccionadas a Siigo Nube' : 'Siigo no está configurado para esta empresa. Haga clic para vincular las credenciales.'}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-xs shadow-sm cursor-pointer disabled:opacity-60 ${botonSiigoActivo ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-slate-200 text-slate-500 border border-slate-300'}`}
            >
              {ocupado === 'siigo' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {ocupado === 'siigo' ? `Transmitiendo (${selectedIds.length})…` : botonSiigoActivo ? 'Enviar a SIIGO' : 'Enviar a SIIGO (Sin conexión)'}
            </button>
          </div>
          {catalogos.error && <p className="text-[11px] text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Siigo: {catalogos.error}. Se usa el catálogo DIAN contingente.</p>}
          <div className="flex flex-wrap justify-center gap-3 text-[11px]">
            <button onClick={onSeedDemo} className="flex items-center gap-1 text-[#e64519] hover:underline cursor-pointer"><Sparkles className="w-3 h-3" /> Inyectar facturas demo</button>
            {onImportFromDrive && <button onClick={onImportFromDrive} className="flex items-center gap-1 text-[#0066da] hover:underline cursor-pointer"><FolderDown className="w-3 h-3" /> Importar de Google Drive</button>}
          </div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs flex flex-col items-center justify-center text-center">
          <FileText className="w-5 h-5 text-[#271a82]" />
          <div className="text-3xl font-black text-[#271a82] mt-1">{facturasUnicas}</div>
          <div className="text-xs font-bold text-slate-700">Facturas Únicas</div>
          <div className="text-[10px] text-slate-400">{lineasContables} líneas contables registradas</div>
          <div className="text-[10px] text-slate-400 mt-1">{facturas.filter(f => f.tipo_operacion === 'VENTA').length} ventas · {facturas.filter(f => f.tipo_operacion !== 'VENTA').length} compras</div>
          <div className={`mt-2 text-[10px] font-bold px-2 py-0.5 rounded-full ${catalogos.conectado ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{catalogos.conectado ? 'Siigo conectado' : catalogos.configurado ? 'Siigo sin respuesta' : 'Catálogo DIAN'}</div>
        </div>
      </div>

      {resultadoCargue && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-3 flex flex-wrap items-center gap-3 text-xs font-semibold text-emerald-800">
          <FileCheck2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>Proceso completado: <b>{resultadoCargue.nuevas}</b> facturas nuevas registradas</span>
          <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800">Duplicadas omitidas: {resultadoCargue.duplicadas}</span>
          <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800">PDF originales guardados: {resultadoCargue.pdfs}</span>
          <span className="text-emerald-700">Los originales quedaron en la carpeta de la empresa.</span>
          <button onClick={() => setResultadoCargue(null)} className="ml-auto p-1 rounded hover:bg-emerald-100 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Filtros y lote */}
      <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs space-y-3">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
            <input type="text" placeholder="Buscar por tercero, NIT, ítem o factura…" value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setPagina(1); }} className="w-full bg-[#f8f9fa] border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-slate-500 font-semibold">Periodo
              <input type="date" value={filtros.desde} onChange={e => { setFiltros({ ...filtros, desde: e.target.value }); setPagina(1); }} className="bg-[#f8f9fa] border border-slate-200 rounded-xl px-2 py-1.5 text-xs text-slate-700" />
              <span>–</span>
              <input type="date" value={filtros.hasta} onChange={e => { setFiltros({ ...filtros, hasta: e.target.value }); setPagina(1); }} className="bg-[#f8f9fa] border border-slate-200 rounded-xl px-2 py-1.5 text-xs text-slate-700" />
            </label>
            <select value={filtros.tipo} onChange={e => { setFiltros({ ...filtros, tipo: e.target.value as FiltrosPeriodo['tipo'] }); setPagina(1); }} className="bg-[#f8f9fa] border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-700 font-medium">
              <option value="TODOS">Todas las transacciones</option>
              <option value="COMPRA">Solo compras (egresos)</option>
              <option value="VENTA">Solo ventas (ingresos)</option>
            </select>
            <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPagina(1); }} className="bg-[#f8f9fa] border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-700 font-medium">
              <option value="TODOS">Todos los estados</option>
              <option value="PENDIENTE">Pendientes</option>
              <option value="AUDITADA">Auditadas</option>
              <option value="SINCRONIZADA_SIIGO">Sincronizadas Siigo</option>
              <option value="RECHAZADA">Rechazadas</option>
            </select>
            <select value={casillaFilter} onChange={e => { setCasillaFilter(e.target.value); setPagina(1); }} className="bg-[#f8f9fa] border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-700 font-medium">
              <option value="TODOS">Todas las casillas F350</option>
              <option value="61">C.61 · Honorarios</option>
              <option value="62">C.62 · Servicios</option>
              <option value="63">C.63 · Arrendamientos</option>
              <option value="64">C.64 · Compras</option>
            </select>
            <button onClick={() => { onRefresh?.(); cargarCatalogos(true); }} title="Refrescar" className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer"><RefreshCw className="w-3.5 h-3.5" /></button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-100">
          <span className="text-[10px] font-bold uppercase text-slate-400 mr-1">Asignación en lote <span className="normal-case font-normal">(a las marcadas)</span>:</span>
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-xl p-1 pl-2.5">
            <span className="text-[10px] font-bold text-slate-600 shrink-0">Banco</span>
            {catalogos.medios_pago.length ? (
              <select value={bancoLote} onChange={e => setBancoLote(e.target.value)} className="bg-transparent px-1.5 py-1.5 text-xs max-w-[160px] focus:outline-none">
                <option value="">Default (Siigo)</option>
                {catalogos.medios_pago.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            ) : (
              <input value={bancoLote} onChange={e => setBancoLote(e.target.value.replace(/[^\d]/g, ''))} placeholder="Cuenta (ej. 11100505)" className="min-w-0 w-44 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-[#271a82]" />
            )}
            <button disabled={!!ocupado} onClick={() => masivo(selectedIds, catalogos.medios_pago.length ? { id_medio_pago: bancoLote || null } : { banco_siigo: bancoLote }, 'Banco asignado')} className="shrink-0 px-2.5 py-1 rounded-lg bg-[#271a82] hover:bg-[#1c1343] text-white text-[10px] font-bold cursor-pointer disabled:opacity-50 transition">Aplicar</button>
          </div>
          {([
            ['fte', 'RteFte', rteLote, setRteLote, catalogos.retefuente, '%', 'bg-red-50 border-red-200 text-red-700'],
            ['ica', 'RteICA', icaLote, setIcaLote, catalogos.reteica, '‰', 'bg-amber-50 border-amber-200 text-amber-700'],
            ['iva', 'RteIVA', ivaLote, setIvaLote, catalogos.reteiva, '%', 'bg-indigo-50 border-indigo-200 text-indigo-700']
          ] as const).map(([tipo, etiqueta, valor, setValor, lista, unidad, clases]) => (
            <div key={tipo} className={`flex items-center gap-1.5 border rounded-xl p-1 pl-2.5 ${clases}`}>
              <span className="text-[10px] font-bold shrink-0">{etiqueta}</span>
              <select value={valor} onChange={e => (setValor as (v: string) => void)(e.target.value)} className="min-w-0 max-w-[170px] bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]">
                <option value="">Elegir…</option>
                {opciones(lista as OpcionImpuesto[], unidad)}
              </select>
              <button disabled={!valor || !!ocupado} onClick={() => masivo(selectedIds, camposRetencion(tipo, valor), `${etiqueta} asignada`)} className="shrink-0 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-[10px] font-bold cursor-pointer disabled:opacity-40 transition">Aplicar</button>
            </div>
          ))}
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-[10px] font-bold text-slate-500">Auditoría:</span>
            <button disabled={!!ocupado} onClick={() => masivo(selectedIds, { estado_revision: 'AUDITADA' }, 'Auditoría en lote')} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-[10px] font-bold cursor-pointer disabled:opacity-50"><CheckCircle2 className="w-3 h-3" /> Auditado</button>
            <button disabled={!!ocupado} onClick={() => masivo(selectedIds, { estado_revision: 'PENDIENTE' }, 'Auditoría en lote')} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-100 text-amber-800 text-[10px] font-bold cursor-pointer disabled:opacity-50"><RotateCcw className="w-3 h-3" /> Pendiente</button>
            {selectedIds.length > 0 && (
              <button onClick={() => { if (window.confirm(`¿Eliminar las ${selectedIds.length} facturas seleccionadas?`)) { onBulkDelete(selectedIds); setSelectedIds([]); } }} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-100 text-red-700 text-[10px] font-bold cursor-pointer"><Trash2 className="w-3 h-3" /> Borrar ({selectedIds.length})</button>
            )}
            {esAdmin && onClearAll && facturas.length > 0 && (
              <button onClick={() => { if (window.confirm(`¿Eliminar TODAS las facturas (${facturas.length}) de ${activeEmpresa?.nombre_comercial || 'esta empresa'}? Esta acción no se puede deshacer.`)) onClearAll(); }} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-red-600 text-[10px] font-bold cursor-pointer hover:bg-red-50"><Eraser className="w-3 h-3" /> Vaciar todo</button>
            )}
          </div>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 font-semibold uppercase text-[10px] border-b border-slate-200">
              <tr>
                <th className="py-3 px-3 w-10 text-center">
                  <button onClick={toggleSelectAll} className="cursor-pointer">
                    {visibles.length > 0 && visibles.every(f => selectedIds.includes(f.id_factura)) ? <CheckSquare className="w-4 h-4 text-[#271A82]" /> : <Square className="w-4 h-4 text-slate-400" />}
                  </button>
                </th>
                <th className="py-3 px-2">Acción</th>
                <th className="py-3 px-2">Factura</th>
                <th className="py-3 px-2">Fecha</th>
                <th className="py-3 px-2">Tercero / NIT</th>
                <th className="py-3 px-2">Ítem / Descripción</th>
                <th className="py-3 px-2 text-right">Cant.</th>
                <th className="py-3 px-2 text-right">V. Unitario</th>
                <th className="py-3 px-2 text-right">Subtotal</th>
                <th className="py-3 px-2 text-right">IVA</th>
                <th className="py-3 px-2">Medio de pago / Banco</th>
                <th className="py-3 px-2">Cta. contable</th>
                <th className="py-3 px-2">RteFte</th>
                <th className="py-3 px-2">RteICA</th>
                <th className="py-3 px-2">RteIVA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibles.length === 0 ? (
                <tr><td colSpan={15} className="py-12 text-center text-slate-400">No se encontraron comprobantes para el filtro seleccionado.</td></tr>
              ) : visibles.map(f => {
                const sel = selectedIds.includes(f.id_factura);
                const esVenta = f.tipo_operacion === 'VENTA';
                const auditada = f.estado_revision === 'AUDITADA' || f.estado_revision === 'SINCRONIZADA_SIIGO';
                const expandida = lineasAbiertas.includes(f.id_factura);
                return (
                  <Fragment key={f.id_factura}>
                  <tr className={`transition ${auditada ? 'bg-emerald-50/70 hover:bg-emerald-100/70 border-l-4 border-l-emerald-500' : sel ? 'bg-indigo-50/40' : 'hover:bg-slate-50/70'}`}>
                    <td className="py-2.5 px-3 text-center">
                      <button onClick={() => toggleSelectOne(f.id_factura)} className="cursor-pointer">{sel ? <CheckSquare className="w-4 h-4 text-[#271A82]" /> : <Square className="w-4 h-4 text-slate-300" />}</button>
                    </td>
                    <td className="py-2.5 px-2">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onUpdateFactura(f.id_factura, 'estado', auditada ? 'PENDIENTE' : 'AUDITADA')}
                          disabled={f.estado_revision === 'SINCRONIZADA_SIIGO'}
                          title={auditada ? 'Auditada (clic para volver a pendiente)' : 'Marcar como auditada'}
                          className={`p-1.5 rounded-lg cursor-pointer ${auditada ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-100 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600'}`}
                        ><CheckCircle2 className="w-3.5 h-3.5" /></button>
                        <button
                          onClick={() => setPdfFactura(f)}
                          title={conPdfOriginal.has(f.id_factura) ? 'Ver el PDF original que venía en el .zip' : 'Ver soporte PDF (representación generada desde el XML: el paquete no traía PDF)'}
                          className={`p-1.5 rounded-lg cursor-pointer ${conPdfOriginal.has(f.id_factura) ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-indigo-50 hover:bg-indigo-100 text-[#271a82]'}`}
                        ><Eye className="w-3.5 h-3.5" /></button>
                        <button onClick={() => onDeleteFactura(f.id_factura)} title="Eliminar" className="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                    <td className="py-2.5 px-2">
                      <div className="font-bold text-[#271a82] whitespace-nowrap">{f.factura_num}</div>
                      <span className={`inline-block mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold ${esVenta ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{esVenta ? 'Venta' : 'Compra'}</span>
                      <span className={`inline-block mt-0.5 ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold ${
                        f.estado_revision === 'AUDITADA' ? 'bg-blue-100 text-blue-700' :
                        f.estado_revision === 'SINCRONIZADA_SIIGO' ? 'bg-emerald-100 text-emerald-700' :
                        f.estado_revision === 'RECHAZADA' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>{f.estado_revision}</span>
                      <button onClick={() => onInspectCufe(f)} className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-[#e64519] font-mono cursor-pointer mt-0.5" title="Inspeccionar CUFE UBL 2.1"><ShieldCheck className="w-3 h-3 text-emerald-600" />{(f.cufe_hash || '').substring(0, 8)}…</button>
                      {f.siigo_id && <div className="text-[9px] font-mono text-emerald-700 font-bold">{f.siigo_id}</div>}
                    </td>
                    <td className="py-2.5 px-2 font-mono text-slate-600 whitespace-nowrap text-[11px]">{f.fecha}</td>
                    <td className="py-2.5 px-2 max-w-[170px]">
                      <div className="font-semibold text-slate-800 truncate" title={f.proveedor}>{f.proveedor}</div>
                      <div className="text-[10px] text-slate-400 font-mono">NIT: {f.nit_tercero}</div>
                    </td>
                    <td className="py-2.5 px-2 max-w-[190px]">
                      <div className="text-slate-700 truncate" title={(f.items || []).map(i => `${i.descripcion_item} × ${i.cantidad}`).join('\n') || f.descripcion_item}>{f.descripcion_item}</div>
                      <button onClick={() => alternarLineas(f.id_factura)} className="text-[10px] font-bold text-[#271a82] hover:underline cursor-pointer">{lineasAbiertas.includes(f.id_factura) ? "▾" : "▸"} {f.items?.length || 1} línea(s)</button>
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono">{f.cantidad}</td>
                    <td className="py-2.5 px-2 text-right font-mono whitespace-nowrap">{formatCOP(f.valor_unitario)}</td>
                    <td className="py-2.5 px-2 text-right font-bold text-slate-800 whitespace-nowrap">{formatCOP(f.subtotal)}</td>
                    <td className="py-2.5 px-2 text-right text-emerald-700 whitespace-nowrap">{formatCOP(f.iva)}</td>
                    <td className="py-2.5 px-2">
                      {catalogos.medios_pago.length ? (
                        <select value={f.id_medio_pago ? String(f.id_medio_pago) : ''} onChange={e => masivo([f.id_factura], { id_medio_pago: e.target.value || null })} className="border border-slate-200 rounded px-1 py-1 text-[11px] font-semibold text-slate-700 bg-white max-w-[140px]">
                          <option value="">Default (Siigo)</option>
                          {catalogos.medios_pago.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      ) : (
                        <input
                          key={`banco-${f.id_factura}-${f.banco_siigo || ''}`}
                          defaultValue={f.banco_siigo || ''}
                          placeholder="Default (Siigo)"
                          onBlur={e => { const v = e.target.value.replace(/[^\d]/g, ''); if (v !== (f.banco_siigo || '')) masivo([f.id_factura], { banco_siigo: v }); }}
                          className="w-28 bg-slate-50 border border-slate-200 rounded px-2 py-1 text-[11px] font-mono text-slate-700"
                        />
                      )}
                    </td>
                    <td className="py-2.5 px-2">
                      <div className="flex items-center gap-1">
                        <input
                          id={`cta-${f.id_factura}`}
                          key={`cta-${f.id_factura}-${f.cuenta_gasto}`}
                          defaultValue={f.cuenta_gasto}
                          list="lista-puc"
                          onBlur={e => { const v = e.target.value.replace(/[^\d]/g, ''); if (v && v !== f.cuenta_gasto) onUpdateFactura(f.id_factura, 'cuenta', v); }}
                          className="w-24 border border-slate-200 rounded px-1.5 py-1 text-[11px] font-mono font-bold text-[#271a82]"
                        />
                        <button onClick={() => copiarCuenta(f)} title={filtrosActivos ? 'Copiar esta cuenta a las facturas filtradas' : 'Copiar esta cuenta a todas las facturas del proveedor'} className="p-1 text-slate-400 hover:text-[#271a82] cursor-pointer"><Copy className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                    {esVenta ? (
                      <td colSpan={3} className="py-2.5 px-2 text-[10px] text-slate-400">Retenciones no aplican en ventas</td>
                    ) : (
                      <>
                        <td className="py-2.5 px-2 align-top">
                          <select value={valorRetencion(f, 'fte')} onChange={e => masivo([f.id_factura], camposRetencion('fte', e.target.value))} className="w-[150px] h-7 border border-red-200 rounded px-1.5 text-[11px] font-bold text-red-700 bg-red-50/80">
                            <option value="">Sin Retención (0%)</option>
                            {opciones(catalogos.retefuente.filter(o => Number(o.percentage) > 0), '%')}
                          </select>
                          {f.retencion_valor ? <div className="text-[10px] text-red-700 mt-0.5">-{formatCOP(Math.abs(f.retencion_valor))}</div> : null}
                        </td>
                        <td className="py-2.5 px-2 align-top">
                          <select value={valorRetencion(f, 'ica')} onChange={e => masivo([f.id_factura], camposRetencion('ica', e.target.value))} className="w-[150px] h-7 border border-amber-200 rounded px-1.5 text-[11px] font-bold text-amber-700 bg-amber-50/80">
                            <option value="">Sin ReteICA (0‰)</option>
                            {opciones(catalogos.reteica.filter(o => Number(o.percentage) > 0), '‰')}
                          </select>
                          {(f.reteica_tarifa || 0) > 0 && <div className="text-[10px] text-amber-700 mt-0.5">-{formatCOP(Math.abs(f.subtotal) * (f.reteica_tarifa || 0) / 1000)}</div>}
                        </td>
                        <td className="py-2.5 px-2 align-top">
                          <select value={valorRetencion(f, 'iva')} onChange={e => masivo([f.id_factura], camposRetencion('iva', e.target.value))} className="w-[150px] h-7 border border-indigo-200 rounded px-1.5 text-[11px] font-bold text-indigo-700 bg-indigo-50/80">
                            <option value="">Sin ReteIVA (0%)</option>
                            {opciones(catalogos.reteiva.filter(o => Number(o.percentage) > 0), '%')}
                          </select>
                          {(f.reteiva_porc || 0) > 0 && <div className="text-[10px] text-indigo-700 mt-0.5">-{formatCOP(Math.abs(f.iva) * (f.reteiva_porc || 0) / 100)}</div>}
                        </td>
                      </>
                    )}
                  </tr>
                  {expandida && (
                    <tr className="bg-slate-50/80">
                      <td colSpan={15} className="px-6 py-3">
                        <div className="text-[11px] font-bold text-slate-600 mb-2">Líneas de {f.factura_num}: asigne la cuenta contable y el centro de costo de cada una</div>
                        {!cuentasPUC.length && <div className="text-[11px] text-amber-700 mb-2">Esta empresa no tiene plan de cuentas cargado. Cárguelo en Cerebro Contable PUC.</div>}
                        {centrosCC.mensaje && <div className="text-[11px] text-amber-700 mb-2">{centrosCC.mensaje}</div>}
                        <div className="overflow-x-auto"><table className="min-w-[780px] w-full text-[11px] bg-white border border-slate-200 rounded-lg">
                          <thead className="text-slate-400 uppercase text-[9px]">
                            <tr><th className="text-left px-2 py-1">Línea</th><th className="text-left">Descripción</th><th className="text-right">Cant.</th><th className="text-right">Subtotal</th><th className="text-right pr-6">IVA</th><th className="text-left pl-6">Cuenta contable</th><th className="text-left pl-4">Centro de costo</th></tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {(f.items || []).map(i => (
                              <tr key={i.linea}>
                                <td className="px-2 py-1.5 font-mono text-slate-500">{i.linea}</td>
                                <td className="py-1.5 pr-2 text-slate-700">{i.descripcion_item}</td>
                                <td className="py-1.5 text-right font-mono">{i.cantidad}</td>
                                <td className="py-1.5 text-right font-semibold whitespace-nowrap">{formatCOP(i.subtotal)}</td>
                                <td className="py-1.5 pr-6 text-right text-emerald-700 whitespace-nowrap">{formatCOP(i.iva)}</td>
                                <td className="py-1.5 pl-6 pr-2">
                                  <input
                                    key={`lc-${f.id_factura}-${i.linea}-${i.cuenta_contable || ''}`}
                                    defaultValue={i.cuenta_contable || ''}
                                    placeholder={f.cuenta_gasto}
                                    list="lista-puc"
                                    onBlur={e => { const v = e.target.value.replace(/[^\d]/g, ''); if (v !== (i.cuenta_contable || '')) guardarLinea(f, i.linea, { cuenta_contable: v }); }}
                                    className="w-28 border border-slate-200 rounded px-1.5 py-1 font-mono font-bold text-[#271a82]"
                                  />
                                </td>
                                <td className="py-1.5 pl-4">
                                  <select
                                    value={i.centro_costo?.id ?? ''}
                                    disabled={!centrosCC.centros.length}
                                    onChange={e => { const c = centrosCC.centros.find(x => String(x.id) === e.target.value); guardarLinea(f, i.linea, { centro_costo: c ?? null }); }}
                                    className="border border-slate-200 rounded px-1 py-1 max-w-[240px] disabled:opacity-60"
                                  >
                                    <option value="">Sin centro de costo</option>
                                    {centrosCC.centros.map(c => <option key={c.id} value={c.id}>{c.codigo} · {c.nombre}</option>)}
                                  </select>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table></div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-100 text-[11px] text-slate-500 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5">Mostrar:
            <select value={String(tamPagina)} onChange={e => { setTamPagina(e.target.value === 'all' ? 'all' : Number(e.target.value)); setPagina(1); }} className="border border-slate-200 rounded px-1.5 py-1">
              <option value="25">25 por página</option>
              <option value="50">50 por página</option>
              <option value="100">100 por página</option>
              <option value="all">Todas las facturas</option>
            </select>
          </label>
          <span>{filteredFacturas.length ? `Página ${paginaSegura} de ${totalPaginas} (${inicio + 1}-${fin} de ${filteredFacturas.length})` : 'Sin registros'}</span>
          <div className="ml-auto flex gap-1">
            <button disabled={paginaSegura <= 1} onClick={() => setPagina(paginaSegura - 1)} className="px-2.5 py-1 rounded-lg border border-slate-200 disabled:opacity-40 cursor-pointer">Anterior</button>
            <button disabled={paginaSegura >= totalPaginas} onClick={() => setPagina(paginaSegura + 1)} className="px-2.5 py-1 rounded-lg border border-slate-200 disabled:opacity-40 cursor-pointer">Siguiente</button>
          </div>
        </div>
      </div>

      {/* Visor PDF */}
      {pdfFactura && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4" onClick={() => setPdfFactura(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-sm font-bold text-slate-800 truncate">Soporte de {pdfFactura.factura_num} · {pdfFactura.proveedor}</div>
                {conPdfOriginal.has(pdfFactura.id_factura)
                  ? <span className="shrink-0 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">PDF original del .zip</span>
                  : <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold" title="El paquete cargado no traía PDF para esta factura">Representación generada desde el XML</span>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <a href={`/api/v1/empresas/${pdfFactura.id_empresa}/facturas/${pdfFactura.id_factura}/pdf?descargar=1`} className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:underline"><Download className="w-3.5 h-3.5" /> Descargar PDF</a>
                <a href={`/api/v1/empresas/${pdfFactura.id_empresa}/facturas/${pdfFactura.id_factura}/pdf`} target="_blank" rel="noreferrer" className="text-[11px] font-bold text-[#271a82] hover:underline">Abrir en otra pestaña</a>
                <button onClick={() => setPdfFactura(null)} className="p-1 rounded hover:bg-slate-100 cursor-pointer"><X className="w-4 h-4 text-slate-500" /></button>
              </div>
            </div>
            <iframe key={pdfFactura.id_factura} title="Soporte PDF" src={`/api/v1/empresas/${pdfFactura.id_empresa}/facturas/${pdfFactura.id_factura}/pdf`} className="w-full h-[75vh] rounded-b-2xl" />
          </div>
        </div>
      )}

      {/* Configuración Siigo */}
      {modalSiigo && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setModalSiigo(false)}>
          <form onSubmit={guardarConfigSiigo} className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 bg-[#271a82] rounded-t-2xl text-white">
              <div className="flex items-center gap-2 text-sm font-bold"><KeyRound className="w-4 h-4 text-[#fa9d1c]" /> Configuración Siigo Nube API</div>
              <button type="button" onClick={() => setModalSiigo(false)} className="cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[11px] text-slate-500">Vincula {activeEmpresa?.nombre_comercial || 'esta empresa'} con su cuenta de Siigo. Las credenciales se prueban en vivo antes de guardarse.</p>
              <label className="block"><span className="text-[11px] font-bold text-slate-600 uppercase">Usuario API (correo registrado en Siigo)</span>
                <input type="email" value={siigoUser} onChange={e => setSiigoUser(e.target.value)} placeholder="contabilidad@empresa.com" className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" required /></label>
              <label className="block"><span className="text-[11px] font-bold text-slate-600 uppercase">Access Key (llave secreta)</span>
                <input type="password" autoComplete="off" value={siigoKey} onChange={e => setSiigoKey(e.target.value)} placeholder="Pegar la Access Key de Siigo… (vacío = conservar la actual)" className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono" /></label>
              <label className="block"><span className="text-[11px] font-bold text-slate-600 uppercase">ID tipo de documento de compra</span>
                <input type="number" value={siigoDoc} onChange={e => setSiigoDoc(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
                <span className="text-[10px] text-slate-400">El ID del comprobante FC (factura de compra) configurado en Siigo Nube.</span></label>
              {siigoEstado && <div className={`p-2.5 rounded-lg text-[11px] font-semibold border ${siigoEstado.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>{siigoEstado.texto}</div>}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
              <button type="button" onClick={() => setModalSiigo(false)} className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold cursor-pointer">Cancelar</button>
              <button type="submit" disabled={ocupado === 'siigo'} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-60">
                {ocupado === 'siigo' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Validar y guardar
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Informe de transmisión a Siigo */}
      {informeSiigo && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setInformeSiigo(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-800"><Send className="w-4 h-4 text-emerald-600" /> Transmisión a Siigo Nube</div>
              <button onClick={() => setInformeSiigo(null)} className="p-1 rounded hover:bg-slate-100 cursor-pointer"><X className="w-4 h-4 text-slate-500" /></button>
            </div>
            <div className="p-5 space-y-2 text-xs">
              <div className="flex justify-between bg-emerald-50 border border-emerald-100 rounded-xl p-2.5 font-semibold text-emerald-800"><span>Facturas exitosas</span><b className="font-mono">{informeSiigo.exitosas}</b></div>
              <div className="flex justify-between bg-red-50 border border-red-100 rounded-xl p-2.5 font-semibold text-red-800"><span>Rechazadas / fallidas</span><b className="font-mono">{informeSiigo.fallidas}</b></div>
              {informeSiigo.omitidas > 0 && <div className="flex justify-between bg-slate-50 border border-slate-200 rounded-xl p-2.5 font-semibold text-slate-700"><span>Omitidas (ventas o ya enviadas)</span><b className="font-mono">{informeSiigo.omitidas}</b></div>}
              {informeSiigo.reporte_detalle.some(r => r.status !== 'success') && (
                <ul className="max-h-40 overflow-y-auto bg-red-50/60 border border-red-100 rounded-xl p-2.5 list-disc pl-6 text-red-800 space-y-1">
                  {informeSiigo.reporte_detalle.filter(r => r.status !== 'success').map((r, i) => <li key={i}><b>{r.factura_num}</b> ({r.proveedor}): {r.mensaje}</li>)}
                </ul>
              )}
              <button onClick={descargarInformeSiigo} className="w-full mt-2 flex items-center justify-center gap-2 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-[#271a82] border border-indigo-200 font-bold cursor-pointer"><Download className="w-4 h-4" /> Descargar informe de transmisión (Excel)</button>
            </div>
          </div>
        </div>
      )}

      {/* Exportación a ERP */}
      {erpAbierto && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setErpAbierto(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-emerald-100 rounded-lg"><FileDown className="w-4 h-4 text-emerald-700" /></div>
                <div>
                  <div className="text-sm font-bold text-slate-800">Exportación a ERP</div>
                  <div className="text-[11px] text-slate-500">Plantilla de comprobantes contables de Siigo · {objetivoTexto}</div>
                </div>
              </div>
              <button onClick={() => setErpAbierto(false)} className="p-1 rounded hover:bg-slate-100 cursor-pointer"><X className="w-4 h-4 text-slate-500" /></button>
            </div>
            <div className="p-5 space-y-3">
              <label className="block"><span className="text-[11px] font-bold text-slate-600 uppercase">Tipo de comprobante Siigo</span>
                <input value={erpTipo} onChange={e => setErpTipo(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" placeholder="Ej: 11" /></label>
              <label className="block"><span className="text-[11px] font-bold text-slate-600 uppercase">Prefijo de documento (opcional)</span>
                <input value={erpPrefijo} onChange={e => setErpPrefijo(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" placeholder="Ej: FE, SETT, CC" /></label>
              <label className="block"><span className="text-[11px] font-bold text-slate-600 uppercase">Consecutivo numérico inicial</span>
                <input type="number" min={1} value={erpConsecutivo} onChange={e => setErpConsecutivo(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" /></label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"><input type="checkbox" checked={erpSoloAuditadas} onChange={e => setErpSoloAuditadas(e.target.checked)} /> Exportar solo facturas auditadas</label>
              <button onClick={() => setErpAvanzado(!erpAvanzado)} className="flex items-center gap-1.5 text-[11px] font-bold text-[#271a82] cursor-pointer"><Settings2 className="w-3.5 h-3.5" /> {erpAvanzado ? 'Ocultar' : 'Ver'} cuentas de contrapartida</button>
              {erpAvanzado && (
                <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-slate-50 border border-slate-200">
                  {CUENTAS_AVANZADAS.map(c => (
                    <label key={c.clave} className="block"><span className="text-[10px] font-semibold text-slate-500">{c.etiqueta}</span>
                      <input value={erpCuentas[c.clave] ?? ''} placeholder={c.defecto} onChange={e => setErpCuentas({ ...erpCuentas, [c.clave]: e.target.value.replace(/[^\d]/g, '') })} className="mt-0.5 w-full border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono bg-white" /></label>
                  ))}
                  <p className="col-span-2 text-[10px] text-slate-500">Cada factura genera un comprobante de partida doble: ingreso o gasto por línea, IVA, retenciones y la contrapartida (cliente, proveedor o el banco asignado). Se valida el cuadre antes de descargar.</p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100">
              <button onClick={() => setErpAbierto(false)} className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold cursor-pointer">Cancelar</button>
              <button onClick={exportarErp} disabled={ocupado === 'erp'} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-60">
                {ocupado === 'erp' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} Descargar archivo ERP
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
