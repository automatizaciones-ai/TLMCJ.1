/**
 * Rutas de la Consola TLM v4:
 *  - Almacenamiento documental por empresa (Google Drive / unidad compartida / local)
 *  - Cargue y Auditoría: auditoría Excel, exportación ERP Siigo, soportes PDF, asignación masiva
 *  - Conciliación bancaria por empresa (auxiliar + extracto) con reporte y plano de ajustes
 *  - Dashboard Directivo y Cerebro Contable (PUC / balance) por empresa
 *
 * Todas las salidas se archivan automáticamente en el espacio de la empresa activa.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { db } from '../storage/dataStore.ts';
import { pool } from '../../db/index.ts';
import { CloudSqlService } from '../services/cloudSqlService.ts';
import type { Empresa, Factura, Usuario } from '../domain/types.ts';
import {
  EmpresaStorageService,
  CATEGORIAS_ARCHIVO,
  LISTA_CATEGORIAS,
  periodoActual,
  type CategoriaArchivo,
  type EmpresaRef,
  type ResultadoArchivo
} from '../services/empresaStorageService.ts';
import {
  generarAuditoriaExcel,
  asientoFactura,
  planoSiigo,
  validarCuadre,
  conciliar,
  reporteConciliacionExcel,
  extractoAExcel,
  comprobantesAjuste,
  resumenDashboard,
  CUENTAS_ERP_DEFECTO,
  type CuentasErp,
  type ParametrosAjuste,
  type ResultadoConciliacion,
  type Agrupacion
} from '../services/contabilidadService.ts';
import { generarZipSoportes, generarPdfFactura } from '../services/soportesPdfService.ts';
import { SoportesOriginales } from '../services/soportesOriginalesService.ts';
import { leerAuxiliar, leerExtracto, leerPuc, leerBalance, type LecturaMovimientos } from '../services/lectorArchivosContables.ts';
import { siigoService, type CredencialesSiigo } from '../services/siigoService.ts';
import { CATALOGO_RTEFTE, CATALOGO_RTEICA, CATALOGO_RTEIVA, casillaPorTarifa } from '../../shared/catalogosDian.ts';
import * as XLSX from 'xlsx';

const router = express.Router();
const upload = multer({ limits: { fileSize: 80 * 1024 * 1024 } });

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ==========================================
// Utilidades comunes
// ==========================================
async function obtenerEmpresa(id: number): Promise<Empresa | null> {
  const enLinea = await CloudSqlService.getEmpresas().catch(() => [] as Empresa[]);
  return enLinea.find(e => e.id_empresa === id) || db.empresas.find(e => e.id_empresa === id) || null;
}

const refEmpresa = (e: Empresa): EmpresaRef => ({ id_empresa: e.id_empresa, nit: e.nit, nombre_comercial: e.nombre_comercial });

async function facturasEmpresa(idEmpresa: number, ids?: number[]): Promise<Factura[]> {
  let lista = await CloudSqlService.getFacturas(idEmpresa).catch(() => [] as Factura[]);
  if (lista.length === 0) lista = db.facturas.filter(f => f.id_empresa === idEmpresa);
  if (ids && ids.length) lista = lista.filter(f => ids.includes(f.id_factura));
  return [...lista].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || a.factura_num.localeCompare(b.factura_num));
}

const parseIds = (v: unknown): number[] => {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return arr.map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0);
};

function usuarioDeRequest(req: Request): Usuario | null {
  const id = Number(req.headers['x-tlm-user-id']);
  if (!id) return null;
  return db.usuarios.find(u => u.id_usuario === id) || null;
}

const nombreUsuario = (req: Request) => usuarioDeRequest(req)?.nombre_completo || (req.headers['x-user-name'] as string) || 'Sistema';

const esAdmin = (u: Usuario | null) => Boolean(u && (u.rol === 'Administrador' || u.rol === 'Desarrollador' || u.permisos?.administrador));

/** Carga la empresa de :id y valida que el usuario (si se identifica) tenga acceso a ella. */
async function conEmpresa(req: Request, res: Response, next: NextFunction) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ detail: 'Identificador de empresa inválido.' });
  const empresa = await obtenerEmpresa(id);
  if (!empresa) return res.status(404).json({ detail: 'Empresa no encontrada.' });
  const u = usuarioDeRequest(req);
  if (u && !esAdmin(u) && Array.isArray(u.empresas_ids) && u.empresas_ids.length && !u.empresas_ids.includes(id)) {
    return res.status(403).json({ detail: 'Su usuario no tiene acceso a esta empresa.' });
  }
  (req as any).empresa = empresa;
  next();
}

function soloAdmin(req: Request, res: Response, next: NextFunction) {
  if (!esAdmin(usuarioDeRequest(req))) {
    return res.status(403).json({ detail: 'Solo un Administrador o Desarrollador puede cambiar el almacenamiento de las empresas.' });
  }
  next();
}

const empresaDe = (req: Request) => (req as any).empresa as Empresa;

/** Archiva y expone el resultado en cabeceras para que la interfaz pueda informarlo. */
async function archivarYEnviar(
  req: Request,
  res: Response,
  params: { categoria: CategoriaArchivo; nombre: string; contenido: Buffer; mime: string; periodo?: string; descargar?: boolean }
) {
  const empresa = empresaDe(req);
  const r = await EmpresaStorageService.archivar({
    empresa: refEmpresa(empresa),
    categoria: params.categoria,
    nombre: params.nombre,
    contenido: params.contenido,
    mime: params.mime,
    periodo: params.periodo,
    usuario: nombreUsuario(req)
  });
  res.setHeader('Access-Control-Expose-Headers', 'X-TLM-Archivado, X-TLM-Archivado-Detalle, Content-Disposition');
  res.setHeader('X-TLM-Archivado', r.ok ? (r.omitido ? 'omitido' : 'ok') : 'error');
  res.setHeader('X-TLM-Archivado-Detalle', encodeURIComponent(r.ok ? (r.archivo?.url || r.archivo?.nombre || '') : (r.error || '')));
  if (params.descargar !== false) {
    res.setHeader('Content-Type', params.mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(params.nombre)}`);
    res.send(params.contenido);
  }
  return r;
}

const periodoDeFacturas = (facturas: Factura[]) => {
  const fechas = facturas.map(f => f.fecha).filter(f => /^\d{4}-\d{2}/.test(f)).sort();
  return fechas.length ? fechas[fechas.length - 1].substring(0, 7) : periodoActual();
};

/** Filtros compartidos de periodo y tipo (?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&tipo=VENTA|COMPRA) */
function filtrarPeriodo(lista: Factura[], req: Request): Factura[] {
  const desde = String(req.query.desde || '');
  const hasta = String(req.query.hasta || '');
  const tipo = String(req.query.tipo || '').toUpperCase();
  return lista.filter(f =>
    (!desde || (f.fecha || '') >= desde) &&
    (!hasta || (f.fecha || '') <= hasta) &&
    (!['VENTA', 'COMPRA'].includes(tipo) || (f.tipo_operacion || 'COMPRA') === tipo)
  );
}

const marcaTiempo = () => new Date().toISOString().replace(/[:T]/g, '-').substring(0, 16);

// ==========================================
// 1. ALMACENAMIENTO POR EMPRESA
// ==========================================
router.get('/almacenamiento/credenciales', (_req, res) => {
  const c = EmpresaStorageService.credenciales();
  res.json({
    google: c,
    google_configurado: Boolean(c.modo),
    directorio_local: EmpresaStorageService.directorioLocalBase,
    categorias: LISTA_CATEGORIAS.map(k => ({ clave: k, ...CATEGORIAS_ARCHIVO[k] }))
  });
});

router.get('/almacenamiento/resumen', async (_req, res) => {
  const empresas = await CloudSqlService.getEmpresas().catch(() => [] as Empresa[]);
  const lista = empresas.length ? empresas : db.empresas;
  res.json(
    lista.map(e => {
      const cfg = EmpresaStorageService.obtenerConfig(e.id_empresa);
      return {
        id_empresa: e.id_empresa,
        nombre_comercial: e.nombre_comercial,
        nit: e.nit,
        proveedor: cfg.proveedor,
        estado: cfg.estado,
        carpeta_empresa_url: cfg.carpeta_empresa_url,
        raiz_nombre: cfg.raiz_nombre,
        ultimo_error: cfg.ultimo_error,
        resumen: EmpresaStorageService.resumenArchivos(e.id_empresa)
      };
    })
  );
});

router.get('/empresas/:id/almacenamiento', conEmpresa, (req, res) => {
  const e = empresaDe(req);
  res.json({
    config: EmpresaStorageService.obtenerConfig(e.id_empresa),
    resumen: EmpresaStorageService.resumenArchivos(e.id_empresa),
    ruta_local: EmpresaStorageService.rutaLocalEmpresa(refEmpresa(e))
  });
});

router.put('/empresas/:id/almacenamiento', conEmpresa, soloAdmin, async (req, res) => {
  const e = empresaDe(req);
  try {
    const cfg = await EmpresaStorageService.guardarConfig(refEmpresa(e), req.body || {}, nombreUsuario(req));
    let inicializada = cfg;
    let error_inicializacion: string | undefined;
    if (req.body?.inicializar !== false) {
      try {
        inicializada = await EmpresaStorageService.inicializarEstructura(refEmpresa(e), nombreUsuario(req));
      } catch (err: any) {
        error_inicializacion = err.message;
        inicializada = EmpresaStorageService.obtenerConfig(e.id_empresa);
      }
    }
    await CloudSqlService.addModificacion({
      autor_nombre: nombreUsuario(req),
      tipo_accion: 'CONFIG_UPDATE',
      descripcion: `Almacenamiento de ${e.nombre_comercial} configurado: ${cfg.proveedor}`,
      detalles: cfg.raiz_url || 'Servidor local'
    }).catch(() => {});
    res.json({ config: inicializada, error_inicializacion, mensaje: error_inicializacion ? `Configuración guardada, pero no se pudo crear la estructura: ${error_inicializacion}` : 'Almacenamiento configurado y estructura de carpetas creada.' });
  } catch (err: any) {
    res.status(400).json({ detail: err.message });
  }
});

router.post('/empresas/:id/almacenamiento/inicializar', conEmpresa, soloAdmin, async (req, res) => {
  const e = empresaDe(req);
  try {
    const cfg = await EmpresaStorageService.inicializarEstructura(refEmpresa(e), nombreUsuario(req));
    res.json({ config: cfg, mensaje: 'Conexión verificada y carpetas de la empresa listas.' });
  } catch (err: any) {
    res.status(400).json({ detail: err.message, config: EmpresaStorageService.obtenerConfig(e.id_empresa) });
  }
});

router.get('/empresas/:id/archivos', conEmpresa, (req, res) => {
  const categoria = req.query.categoria as CategoriaArchivo | undefined;
  const lista = EmpresaStorageService.listarArchivos(empresaDe(req).id_empresa, categoria && LISTA_CATEGORIAS.includes(categoria) ? categoria : undefined, 500);
  res.json(lista.map(({ referencia, sha256, ...resto }) => resto));
});

router.get('/empresas/:id/archivos/:archivoId/descargar', conEmpresa, async (req, res) => {
  try {
    const { archivo, contenido } = await EmpresaStorageService.leerArchivo(empresaDe(req).id_empresa, req.params.archivoId);
    res.setHeader('Content-Type', archivo.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(archivo.nombre)}`);
    res.send(contenido);
  } catch (err: any) {
    res.status(404).json({ detail: err.message });
  }
});

router.delete('/empresas/:id/archivos/:archivoId', conEmpresa, soloAdmin, async (req, res) => {
  try {
    await EmpresaStorageService.eliminarArchivo(empresaDe(req).id_empresa, req.params.archivoId);
    res.json({ mensaje: 'Archivo eliminado del almacenamiento de la empresa.' });
  } catch (err: any) {
    res.status(400).json({ detail: err.message });
  }
});

router.post('/empresas/:id/almacenamiento/respaldo', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const facturas = await facturasEmpresa(e.id_empresa);
  const puc = await CloudSqlService.getCuentasPuc(e.id_empresa).catch(() => db.cuentasPUC.filter(c => c.id_empresa === e.id_empresa));
  const balance = await CloudSqlService.getBalanceTerceros(e.id_empresa).catch(() => db.balanceTerceros.filter(b => b.id_empresa === e.id_empresa));
  const { siigo_access_key, ...empresaSinSecretos } = e;
  const respaldo = {
    generado_en: new Date().toISOString(),
    generado_por: nombreUsuario(req),
    empresa: empresaSinSecretos,
    facturas,
    cuentas_puc: puc,
    balance_terceros: balance,
    ultima_conciliacion: conciliaciones.get(e.id_empresa)?.resultado || null
  };
  const r = await EmpresaStorageService.archivar({
    empresa: refEmpresa(e),
    categoria: 'RESPALDOS',
    nombre: `Respaldo_${e.nit}_${marcaTiempo()}.json`,
    contenido: Buffer.from(JSON.stringify(respaldo, null, 2)),
    mime: 'application/json',
    usuario: nombreUsuario(req),
    forzar: true
  });
  if (!r.ok) return res.status(502).json({ detail: r.error });
  res.json({ mensaje: `Respaldo guardado: ${facturas.length} facturas, ${puc.length} cuentas PUC, ${balance.length} saldos.`, archivo: r.archivo });
});

// ==========================================
// 2. CARGUE Y AUDITORÍA
// ==========================================
router.get('/empresas/:id/facturas/auditoria-excel', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const facturas = await facturasEmpresa(e.id_empresa, parseIds(req.query.ids));
  if (!facturas.length) return res.status(404).json({ detail: 'No hay facturas para auditar en esta empresa.' });
  await archivarYEnviar(req, res, {
    categoria: 'AUDITORIA',
    nombre: `Auditoria_TLM_${e.nit}_${marcaTiempo()}.xlsx`,
    contenido: generarAuditoriaExcel(facturas),
    mime: MIME_XLSX,
    periodo: periodoDeFacturas(facturas)
  });
});

router.post('/empresas/:id/facturas/exportar-erp', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const { tipo_comprobante, prefijo, consecutivo_inicial, ids, cuentas, solo_auditadas } = req.body || {};
  if (!tipo_comprobante || !consecutivo_inicial) {
    return res.status(400).json({ detail: 'Indique el tipo de comprobante Siigo y el consecutivo numérico inicial.' });
  }
  let facturas = await facturasEmpresa(e.id_empresa, parseIds(ids));
  if (solo_auditadas) facturas = facturas.filter(f => f.estado_revision === 'AUDITADA');
  if (!facturas.length) return res.status(404).json({ detail: 'No hay facturas para exportar.' });

  const cuentasErp: CuentasErp = { ...CUENTAS_ERP_DEFECTO, ...(cuentas || {}) };
  const comprobantes = facturas.map(f => asientoFactura(f, cuentasErp));
  const cuadre = validarCuadre(comprobantes);
  if (!cuadre.ok) {
    return res.status(422).json({ detail: 'Hay comprobantes descuadrados; revise las facturas.', descuadres: cuadre.descuadres });
  }
  const plano = planoSiigo(comprobantes, { tipo_comprobante: String(tipo_comprobante), consecutivo_inicial: Number(consecutivo_inicial), prefijo: prefijo || '' });
  res.setHeader('X-TLM-Consecutivo-Final', String(plano.consecutivo_final));
  res.setHeader('Access-Control-Expose-Headers', 'X-TLM-Consecutivo-Final');
  await archivarYEnviar(req, res, {
    categoria: 'EXPORTES_ERP',
    nombre: `Comprobantes_Contables_${tipo_comprobante}_${consecutivo_inicial}.xlsx`,
    contenido: plano.buffer,
    mime: MIME_XLSX,
    periodo: periodoDeFacturas(facturas)
  });
});

router.get('/empresas/:id/facturas/soportes-pdf', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const facturas = await facturasEmpresa(e.id_empresa, parseIds(req.query.ids));
  if (!facturas.length) return res.status(404).json({ detail: 'No hay facturas para generar soportes.' });
  try {
    const zip = await generarZipSoportes(facturas, e, async f => (await SoportesOriginales.obtener(e.id_empresa, f.cufe_hash))?.contenido || null);
    res.setHeader('X-TLM-Pdf-Originales', String(zip.originales));
    res.setHeader('X-TLM-Pdf-Generados', String(zip.generados));
    res.setHeader('Access-Control-Expose-Headers', 'X-TLM-Pdf-Originales, X-TLM-Pdf-Generados');
    await archivarYEnviar(req, res, {
      categoria: 'SOPORTES_PDF',
      nombre: `Soportes_PDF_${e.nit}_${marcaTiempo()}.zip`,
      contenido: zip.buffer,
      mime: 'application/zip',
      periodo: periodoDeFacturas(facturas)
    });
  } catch (err: any) {
    res.status(500).json({ detail: 'Error generando los PDF: ' + err.message });
  }
});

/** IDs de las facturas que tienen el PDF original del paquete DIAN guardado */
router.get('/empresas/:id/facturas/soportes-originales', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const facturas = await facturasEmpresa(e.id_empresa, []);
  const set = await SoportesOriginales.cufesConPdf(e.id_empresa);
  res.json({ ids: facturas.filter(f => SoportesOriginales.tiene(set, f.cufe_hash)).map(f => f.id_factura) });
});

/** Soporte PDF de una factura: el original del .zip si existe; si no, la representación generada desde el XML */
router.get('/empresas/:id/facturas/:facturaId/pdf', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const [f] = await facturasEmpresa(e.id_empresa, [Number(req.params.facturaId)]);
  if (!f) return res.status(404).json({ detail: 'Factura no encontrada en esta empresa.' });
  const original = req.query.generado ? null : await SoportesOriginales.obtener(e.id_empresa, f.cufe_hash);
  const pdf = original?.contenido || (await generarPdfFactura(f, e));
  const nombre = original ? original.nombre : `${f.factura_num}_representacion_XML.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-TLM-Origen-Pdf', original ? 'ORIGINAL' : 'GENERADO');
  res.setHeader('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(nombre)}`);
  res.send(pdf);
});

/** Asignación masiva (barra BANCO / RTEFTE / cuenta) sobre varias facturas */
router.patch('/empresas/:id/facturas/masivo', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const ids = parseIds(req.body?.ids);
  const campos = req.body?.campos || {};
  if (!ids.length) return res.status(400).json({ detail: 'Seleccione al menos una factura.' });
  const facturas = await facturasEmpresa(e.id_empresa, ids);
  let actualizadas = 0;
  for (const f of facturas) {
    const cambios: Partial<Factura> = {};
    if (campos.banco_siigo !== undefined) cambios.banco_siigo = String(campos.banco_siigo);
    if (campos.cuenta_gasto) cambios.cuenta_gasto = String(campos.cuenta_gasto);
    if (campos.estado_revision) cambios.estado_revision = campos.estado_revision;
    if (campos.reteica_tarifa !== undefined) cambios.reteica_tarifa = Number(campos.reteica_tarifa);
    if (campos.reteiva_porc !== undefined) cambios.reteiva_porc = Number(campos.reteiva_porc);
    if (campos.retencion_porc !== undefined) {
      cambios.retencion_porc = Number(campos.retencion_porc);
      cambios.retencion_valor = Math.round((Math.abs(f.subtotal) * cambios.retencion_porc) / 100) * Math.sign(f.subtotal || 1);
      cambios.casilla_350 = campos.casilla_350 !== undefined ? Number(campos.casilla_350) : casillaPorTarifa(cambios.retencion_porc);
    }
    const idSiigo = (v: unknown) => (v === null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : null);
    if (campos.id_medio_pago !== undefined) cambios.id_medio_pago = idSiigo(campos.id_medio_pago) as any;
    if (campos.id_retencion !== undefined) cambios.id_retencion = idSiigo(campos.id_retencion) as any;
    if (campos.id_reteica !== undefined) cambios.id_reteica = idSiigo(campos.id_reteica) as any;
    if (campos.id_reteiva !== undefined) cambios.id_reteiva = idSiigo(campos.id_reteiva) as any;
    await CloudSqlService.updateFactura(f.id_factura, cambios).catch(() => null);
    const local = db.facturas.find(x => x.id_factura === f.id_factura);
    if (local) Object.assign(local, cambios);
    actualizadas++;
  }
  db.saveToDisk();
  res.json({ mensaje: `${actualizadas} factura(s) actualizadas.`, actualizadas });
});

// ==========================================
// 3. DASHBOARD DIRECTIVO
// ==========================================
router.get('/empresas/:id/dashboard', conEmpresa, async (req, res) => {
  const agr = (['dia', 'quincena', 'mes'].includes(String(req.query.agrupacion)) ? req.query.agrupacion : 'quincena') as Agrupacion;
  res.json(resumenDashboard(filtrarPeriodo(await facturasEmpresa(empresaDe(req).id_empresa), req), agr));
});

// ==========================================
// 3b. SIIGO NUBE (credenciales por empresa)
// ==========================================
const credencialesDe = (e: Empresa): CredencialesSiigo | null =>
  e.siigo_username && e.siigo_access_key ? { username: e.siigo_username, access_key: e.siigo_access_key } : null;

/** Catálogos para los desplegables: los de Siigo si la empresa está conectada, o el catálogo DIAN contingente. */
router.get('/empresas/:id/siigo/catalogos', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const cred = credencialesDe(e);
  const contingencia = {
    configurado: Boolean(cred),
    conectado: false,
    fuente: 'CONTINGENCIA_DIAN' as const,
    medios_pago: [] as { id: number; name: string }[],
    retefuente: CATALOGO_RTEFTE.map(t => ({ id: t.id, name: t.nombre, percentage: t.porcentaje })),
    reteica: CATALOGO_RTEICA.map(t => ({ id: t.id, name: t.nombre, percentage: t.porcentaje })),
    reteiva: CATALOGO_RTEIVA.map(t => ({ id: t.id, name: t.nombre, percentage: t.porcentaje })),
    document_id: e.siigo_document_id || 24
  };
  if (!cred) return res.json(contingencia);
  try {
    const { impuestos, medios } = await siigoService.catalogos(cred, req.query.refrescar === '1');
    const c = siigoService.clasificarImpuestos(impuestos);
    res.json({
      ...contingencia,
      conectado: true,
      fuente: 'SIIGO',
      medios_pago: medios,
      retefuente: c.retefuente,
      reteica: c.reteica,
      reteiva: c.reteiva,
      iva: c.iva
    });
  } catch (err: any) {
    res.json({ ...contingencia, error: err.message });
  }
});

/** Transmite facturas de compra a Siigo y devuelve un informe por factura (también archivado en Excel). */
router.post('/empresas/:id/siigo/enviar', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const cred = credencialesDe(e);
  if (!cred) return res.status(400).json({ detail: 'Configure primero las credenciales de Siigo de esta empresa (Config. Siigo).' });
  const ids = parseIds(req.body?.ids);
  if (!ids.length) return res.status(400).json({ detail: 'Seleccione al menos una factura.' });
  const facturas = await facturasEmpresa(e.id_empresa, ids);
  const documentId = Number(req.body?.document_id) || e.siigo_document_id || 24;
  const medioPorDefecto = req.body?.id_medio_pago ? Number(req.body.id_medio_pago) : null;

  const reporte = [];
  for (const f of facturas) {
    const r = await siigoService.enviarCompra(cred, f, { documentId, medioPagoId: f.id_medio_pago || medioPorDefecto });
    if (r.status === 'success') {
      const cambios: Partial<Factura> = { estado_revision: 'SINCRONIZADA_SIIGO', siigo_id: String(r.siigo_nombre || r.siigo_id || '') };
      await CloudSqlService.updateFactura(f.id_factura, cambios).catch(() => null);
      const local = db.facturas.find(x => x.id_factura === f.id_factura);
      if (local) Object.assign(local, cambios);
    }
    const { payloadSent, ...sinPayload } = r;
    reporte.push(sinPayload);
  }
  db.saveToDisk();

  const exitosas = reporte.filter(r => r.status === 'success').length;
  const fallidas = reporte.filter(r => r.status === 'error').length;
  const omitidas = reporte.filter(r => r.status === 'omitida').length;

  // Informe en Excel archivado en la carpeta de la empresa
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reporte.map(r => ({
    'Factura N°': r.factura_num, 'NIT Tercero': r.nit_tercero, Proveedor: r.proveedor,
    Estado: r.status === 'success' ? 'EXITOSA' : r.status === 'omitida' ? 'OMITIDA' : 'FALLIDA',
    'Documento Siigo': r.siigo_nombre || r.siigo_id || '', Detalle: r.mensaje
  }))), 'Transmisión Siigo');
  const informe = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const archivo = await EmpresaStorageService.archivar({
    empresa: refEmpresa(e), categoria: 'EXPORTES_ERP', nombre: `Informe_Transmision_Siigo_${marcaTiempo()}.xlsx`,
    contenido: informe, mime: MIME_XLSX, periodo: periodoDeFacturas(facturas), usuario: nombreUsuario(req)
  });

  res.json({ exitosas, fallidas, omitidas, reporte_detalle: reporte, informe_xlsx_b64: informe.toString('base64'), archivado: archivo.ok && !archivo.omitido });
});

// ==========================================
// 4. CONCILIACIÓN BANCARIA POR EMPRESA
// ==========================================
interface EstadoConciliacion {
  libros?: LecturaMovimientos;
  extracto?: LecturaMovimientos;
  resultado?: ResultadoConciliacion;
  parametros_ajuste?: Partial<ParametrosAjuste>;
}
const archivoConciliaciones = path.resolve(process.cwd(), 'data', 'conciliaciones_empresas.json');
const conciliaciones = new Map<number, EstadoConciliacion>();
try {
  if (fs.existsSync(archivoConciliaciones)) {
    const dump = JSON.parse(fs.readFileSync(archivoConciliaciones, 'utf-8'));
    for (const [k, v] of Object.entries(dump)) conciliaciones.set(Number(k), v as EstadoConciliacion);
  }
} catch (_) {}
const guardarConciliaciones = () => {
  try {
    fs.mkdirSync(path.dirname(archivoConciliaciones), { recursive: true });
    fs.writeFileSync(archivoConciliaciones, JSON.stringify(Object.fromEntries(conciliaciones)));
  } catch (_) {}
};

router.get('/empresas/:id/conciliacion', conEmpresa, (req, res) => {
  const estado = conciliaciones.get(empresaDe(req).id_empresa);
  res.json({
    resultado: estado?.resultado || null,
    parametros_ajuste: estado?.parametros_ajuste || null,
    tiene_auxiliar: Boolean(estado?.libros),
    tiene_extracto: Boolean(estado?.extracto)
  });
});

router.post(
  '/empresas/:id/conciliacion/ejecutar',
  conEmpresa,
  upload.fields([{ name: 'auxiliar', maxCount: 1 }, { name: 'extracto', maxCount: 1 }]),
  async (req, res) => {
    const e = empresaDe(req);
    const archivos = req.files as Record<string, Express.Multer.File[]> | undefined;
    const aux = archivos?.auxiliar?.[0];
    const ext = archivos?.extracto?.[0];
    const estado: EstadoConciliacion = conciliaciones.get(e.id_empresa) || {};
    const archivados: ResultadoArchivo[] = [];

    try {
      if (aux) {
        estado.libros = leerAuxiliar(aux.buffer, aux.originalname);
        (estado.libros as any).archivo = aux.originalname;
      }
      if (ext) {
        estado.extracto = await leerExtracto(ext.buffer, ext.originalname);
        (estado.extracto as any).archivo = ext.originalname;
      }
    } catch (err: any) {
      return res.status(400).json({ detail: err.message });
    }
    if (!estado.libros || !estado.extracto) {
      return res.status(400).json({ detail: 'Cargue el auxiliar de libros (Excel de Siigo) y el extracto bancario.' });
    }

    const tolerancia = Math.max(0, Number(req.body?.tolerancia) || 0);
    const dias = Math.max(0, Math.min(10, Number(req.body?.dias_holgura) || 0));
    const activo = (v: unknown) => !['false', '0', 'no'].includes(String(v ?? 'true').toLowerCase());
    const resultado = conciliar(e.id_empresa, estado.libros, estado.extracto, tolerancia, dias, {
      cruce_por_valor: activo(req.body?.cruce_por_valor),
      cruce_agrupado: activo(req.body?.cruce_agrupado)
    });
    resultado.archivo_auxiliar = (estado.libros as any).archivo;
    resultado.archivo_extracto = (estado.extracto as any).archivo;
    if (req.body?.banco && req.body.banco !== 'AUTO') resultado.banco = String(req.body.banco);
    estado.resultado = resultado;
    conciliaciones.set(e.id_empresa, estado);
    guardarConciliaciones();

    const periodo = (estado.extracto.movimientos[0]?.fecha || '').substring(0, 7) || undefined;
    const ref = refEmpresa(e);
    if (aux) archivados.push(await EmpresaStorageService.archivar({ empresa: ref, categoria: 'CONCILIACIONES', nombre: `Auxiliar_${aux.originalname}`, contenido: aux.buffer, mime: aux.mimetype, periodo, usuario: nombreUsuario(req) }));
    if (ext) archivados.push(await EmpresaStorageService.archivar({ empresa: ref, categoria: 'CONCILIACIONES', nombre: `Extracto_${ext.originalname}`, contenido: ext.buffer, mime: ext.mimetype, periodo, usuario: nombreUsuario(req) }));

    res.json({ ...resultado, archivado: archivados.map(a => ({ ok: a.ok, omitido: a.omitido, error: a.error, nombre: a.archivo?.nombre })) });
  }
);

router.get('/empresas/:id/conciliacion/reporte-excel', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const r = conciliaciones.get(e.id_empresa)?.resultado;
  if (!r) return res.status(404).json({ detail: 'Ejecute primero el cruce de conciliación.' });
  const periodo = (r.conciliadas[0]?.fecha || r.faltan_en_libros[0]?.fecha || '').substring(0, 7) || undefined;
  await archivarYEnviar(req, res, {
    categoria: 'CONCILIACIONES',
    nombre: `Conciliacion_${e.nit}_${periodo || marcaTiempo()}.xlsx`,
    contenido: reporteConciliacionExcel(r, `${e.nombre_comercial} (NIT ${e.nit})`),
    mime: MIME_XLSX,
    periodo
  });
});

router.post('/empresas/:id/conciliacion/extracto-a-excel', conEmpresa, upload.single('extracto'), async (req, res) => {
  const e = empresaDe(req);
  const archivo = req.file;
  let lectura = conciliaciones.get(e.id_empresa)?.extracto;
  try {
    if (archivo) lectura = await leerExtracto(archivo.buffer, archivo.originalname);
  } catch (err: any) {
    return res.status(400).json({ detail: err.message });
  }
  if (!lectura) return res.status(400).json({ detail: 'Seleccione el extracto en PDF.' });
  const base = (archivo?.originalname || 'extracto').replace(/\.[^.]+$/, '');
  await archivarYEnviar(req, res, {
    categoria: 'CONCILIACIONES',
    nombre: `${base}_convertido.xlsx`,
    contenido: extractoAExcel(lectura),
    mime: MIME_XLSX,
    periodo: (lectura.movimientos[0]?.fecha || '').substring(0, 7) || undefined
  });
});

router.post('/empresas/:id/conciliacion/plano-ajustes', conEmpresa, async (req, res) => {
  const e = empresaDe(req);
  const estado = conciliaciones.get(e.id_empresa);
  if (!estado?.resultado) return res.status(404).json({ detail: 'Ejecute primero el cruce de conciliación.' });
  const p = req.body?.parametros || {};
  const requeridos: (keyof ParametrosAjuste)[] = ['nit_banco', 'cuenta_banco', 'tipo_comprobante', 'consecutivo_inicial', 'cuenta_gasto_defecto', 'cuenta_gmf', 'cuenta_iva_descontable', 'cuenta_ingresos_defecto'];
  const faltantes = requeridos.filter(k => p[k] === undefined || p[k] === null || String(p[k]).trim() === '');
  if (faltantes.length) {
    return res.status(400).json({ detail: 'Por favor diligencie todos los campos requeridos.', faltantes });
  }
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const movs = estado.resultado.faltan_en_libros.filter(m => !ids.length || ids.includes(m.id));
  if (!movs.length) return res.status(400).json({ detail: 'Seleccione al menos un movimiento de "Faltan en libros".' });

  const parametros: ParametrosAjuste = { ...p, consecutivo_inicial: Number(p.consecutivo_inicial) } as ParametrosAjuste;
  estado.parametros_ajuste = { ...parametros, consecutivo_inicial: undefined };
  guardarConciliaciones();

  const comprobantes = comprobantesAjuste(movs, parametros);
  const plano = planoSiigo(comprobantes, { tipo_comprobante: parametros.tipo_comprobante, consecutivo_inicial: parametros.consecutivo_inicial, un_solo_comprobante: Boolean(parametros.un_solo_comprobante) }, 'Comprobantes');
  res.setHeader('X-TLM-Consecutivo-Final', String(plano.consecutivo_final));
  res.setHeader('Access-Control-Expose-Headers', 'X-TLM-Consecutivo-Final');
  await archivarYEnviar(req, res, {
    categoria: 'CONCILIACIONES',
    nombre: `Plano_Siigo_Ajustes_${parametros.tipo_comprobante}_${parametros.consecutivo_inicial}.xlsx`,
    contenido: plano.buffer,
    mime: MIME_XLSX,
    periodo: (movs[0]?.fecha || '').substring(0, 7) || undefined
  });
});

// ==========================================
// 5. CEREBRO CONTABLE (PUC Y BALANCE) POR EMPRESA
// ==========================================
async function reemplazarPuc(idEmpresa: number, cuentas: { cuenta: string; nombre: string; naturaleza: string }[]): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM cuentas_puc WHERE id_empresa = $1', [idEmpresa]);
      for (let i = 0; i < cuentas.length; i += 500) {
        const lote = cuentas.slice(i, i + 500);
        await client.query(
          `INSERT INTO cuentas_puc (id_empresa, cuenta, nombre, naturaleza)
           SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[])`,
          [idEmpresa, lote.map(c => c.cuenta), lote.map(c => c.nombre), lote.map(c => c.naturaleza)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return true;
  } catch (err: any) {
    console.warn('[Cerebro] PostgreSQL no disponible para PUC, se guarda localmente:', err.message);
    return false;
  }
}

async function reemplazarBalance(idEmpresa: number, saldos: ReturnType<typeof leerBalance>): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM balance_terceros WHERE id_empresa = $1', [idEmpresa]);
      for (let i = 0; i < saldos.length; i += 500) {
        const l = saldos.slice(i, i + 500);
        await client.query(
          `INSERT INTO balance_terceros (id_empresa, cuenta_contable, nombre_cuenta, nit_tercero, nombre_tercero, saldo_inicial, debitos, creditos, saldo_final)
           SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[])`,
          [idEmpresa, l.map(s => s.cuenta_contable), l.map(s => s.nombre_cuenta), l.map(s => s.nit_tercero), l.map(s => s.nombre_tercero),
            l.map(s => s.saldo_inicial), l.map(s => s.debitos), l.map(s => s.creditos), l.map(s => s.saldo_final)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return true;
  } catch (err: any) {
    console.warn('[Cerebro] PostgreSQL no disponible para balance, se guarda localmente:', err.message);
    return false;
  }
}

router.post('/empresas/:id/cerebro/puc', conEmpresa, upload.single('archivo'), async (req, res) => {
  const e = empresaDe(req);
  if (!req.file) return res.status(400).json({ detail: 'Seleccione el archivo del catálogo PUC.' });
  let cuentas;
  try {
    cuentas = leerPuc(req.file.buffer, req.file.originalname);
  } catch (err: any) {
    return res.status(400).json({ detail: err.message });
  }
  if (!cuentas.length) return res.status(400).json({ detail: 'No se encontraron cuentas (se esperan columnas Código y Nombre).' });

  const enLinea = await reemplazarPuc(e.id_empresa, cuentas);
  let base = Date.now();
  db.cuentasPUC = db.cuentasPUC.filter(c => c.id_empresa !== e.id_empresa).concat(
    cuentas.map(c => ({ id_puc: base++, id_empresa: e.id_empresa, cuenta: c.cuenta, nombre: c.nombre, naturaleza: c.naturaleza }))
  );
  db.saveToDisk();
  const archivo = await EmpresaStorageService.archivar({ empresa: refEmpresa(e), categoria: 'CEREBRO_CONTABLE', nombre: `PUC_${req.file.originalname}`, contenido: req.file.buffer, mime: req.file.mimetype, usuario: nombreUsuario(req) });
  res.json({ mensaje: `Catálogo sincronizado: ${cuentas.length} cuentas para ${e.nombre_comercial}.`, cuentas: cuentas.length, en_base_datos: enLinea, archivado: archivo.ok && !archivo.omitido });
});

router.post('/empresas/:id/cerebro/balance', conEmpresa, upload.single('archivo'), async (req, res) => {
  const e = empresaDe(req);
  if (!req.file) return res.status(400).json({ detail: 'Seleccione el archivo del balance de prueba.' });
  let saldos;
  try {
    saldos = leerBalance(req.file.buffer, req.file.originalname);
  } catch (err: any) {
    return res.status(400).json({ detail: err.message });
  }
  if (!saldos.length) return res.status(400).json({ detail: 'No se encontraron saldos en el archivo.' });

  const enLinea = await reemplazarBalance(e.id_empresa, saldos);
  let base = Date.now();
  db.balanceTerceros = db.balanceTerceros.filter(b => b.id_empresa !== e.id_empresa).concat(
    saldos.map(s => ({ id_balance: base++, id_empresa: e.id_empresa, ...s }))
  );
  db.saveToDisk();
  const archivo = await EmpresaStorageService.archivar({ empresa: refEmpresa(e), categoria: 'CEREBRO_CONTABLE', nombre: `Balance_${req.file.originalname}`, contenido: req.file.buffer, mime: req.file.mimetype, usuario: nombreUsuario(req) });
  res.json({ mensaje: `Saldos sincronizados: ${saldos.length} registros para ${e.nombre_comercial}.`, registros: saldos.length, en_base_datos: enLinea, archivado: archivo.ok && !archivo.omitido });
});

router.delete('/empresas/:id/cerebro/:tipo', conEmpresa, soloAdmin, async (req, res) => {
  const e = empresaDe(req);
  const tipo = req.params.tipo;
  if (tipo === 'puc') {
    await pool.query('DELETE FROM cuentas_puc WHERE id_empresa = $1', [e.id_empresa]).catch(() => {});
    db.cuentasPUC = db.cuentasPUC.filter(c => c.id_empresa !== e.id_empresa);
  } else if (tipo === 'balance') {
    await pool.query('DELETE FROM balance_terceros WHERE id_empresa = $1', [e.id_empresa]).catch(() => {});
    db.balanceTerceros = db.balanceTerceros.filter(b => b.id_empresa !== e.id_empresa);
  } else {
    return res.status(400).json({ detail: 'Tipo inválido (puc | balance).' });
  }
  db.saveToDisk();
  res.json({ mensaje: tipo === 'puc' ? 'Catálogo PUC eliminado.' : 'Balance de prueba eliminado.' });
});

export default router;
