/**
 * Almacenamiento documental por empresa.
 *
 * Cada empresa (tenant) tiene su propio espacio de archivos contables, separado del resto:
 *   - LOCAL                     → carpeta en el servidor:  storage/empresas/<NIT>_<nombre>/
 *   - GOOGLE_DRIVE_CARPETA      → una carpeta de Google Drive (Mi unidad o dentro de una unidad compartida)
 *   - GOOGLE_UNIDAD_COMPARTIDA  → una unidad compartida (Shared Drive) completa
 *
 * Dentro del espacio de cada empresa se crea la misma estructura de subcarpetas por categoría
 * (Facturas XML, Soportes PDF, Auditoría, Exportes ERP, Conciliaciones, Cerebro Contable, Respaldos)
 * y, opcionalmente, una subcarpeta por periodo contable (AAAA-MM).
 *
 * Credenciales de Google (variables de entorno, ver .env.example):
 *   GOOGLE_SERVICE_ACCOUNT_JSON   JSON de la cuenta de servicio (texto plano o base64)
 *   GOOGLE_APPLICATION_CREDENTIALS ruta al JSON de la cuenta de servicio
 *   GOOGLE_DRIVE_IMPERSONATE      (opcional) correo Workspace a suplantar con delegación de dominio
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN  (alternativa OAuth)
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'node:https';
import { JWT, OAuth2Client } from 'google-auth-library';
import { pool } from '../../db/index.ts';

// ==========================================
// Tipos
// ==========================================
export type ProveedorAlmacenamiento = 'LOCAL' | 'GOOGLE_DRIVE_CARPETA' | 'GOOGLE_UNIDAD_COMPARTIDA';

export type CategoriaArchivo =
  | 'FACTURAS_XML'
  | 'SOPORTES_PDF'
  | 'AUDITORIA'
  | 'EXPORTES_ERP'
  | 'CONCILIACIONES'
  | 'CEREBRO_CONTABLE'
  | 'RESPALDOS';

export const CATEGORIAS_ARCHIVO: Record<CategoriaArchivo, { carpeta: string; descripcion: string }> = {
  FACTURAS_XML: { carpeta: '01_Facturas_XML', descripcion: 'ZIP / XML UBL 2.1 originales cargados' },
  SOPORTES_PDF: { carpeta: '02_Soportes_PDF', descripcion: 'Representaciones gráficas en PDF' },
  AUDITORIA: { carpeta: '03_Auditoria', descripcion: 'Excel de auditoría (consolidado y detalle)' },
  EXPORTES_ERP: { carpeta: '04_Exportes_ERP', descripcion: 'Planos de comprobantes para Siigo' },
  CONCILIACIONES: { carpeta: '05_Conciliaciones', descripcion: 'Auxiliares, extractos, reportes y planos de ajuste' },
  CEREBRO_CONTABLE: { carpeta: '06_Cerebro_Contable', descripcion: 'Catálogo PUC y balances de prueba' },
  RESPALDOS: { carpeta: '07_Respaldos', descripcion: 'Copias de seguridad de los datos de la empresa' }
};

export const LISTA_CATEGORIAS = Object.keys(CATEGORIAS_ARCHIVO) as CategoriaArchivo[];

export interface AlmacenamientoEmpresa {
  id_empresa: number;
  proveedor: ProveedorAlmacenamiento;
  /** ID de la carpeta raíz (carpeta) o de la unidad compartida, tal como lo dio el usuario */
  raiz_id?: string;
  raiz_url?: string;
  raiz_nombre?: string;
  /** Si es true se crea una subcarpeta "<NIT> - <Nombre>" dentro de la raíz (útil para una unidad compartida con varias empresas) */
  crear_carpeta_empresa: boolean;
  /** Carpeta efectiva de la empresa (raíz o subcarpeta creada) */
  carpeta_empresa_id?: string;
  carpeta_empresa_url?: string;
  /** ID de la unidad compartida a la que pertenece (si aplica) */
  unidad_compartida_id?: string;
  subcarpetas: Partial<Record<CategoriaArchivo, string>>;
  organizar_por_periodo: boolean;
  archivado_automatico: Record<CategoriaArchivo, boolean>;
  estado: 'SIN_CONFIGURAR' | 'CONECTADO' | 'ERROR';
  ultimo_error?: string;
  verificado_en?: string;
  actualizado_por?: string;
  actualizado_en?: string;
}

export interface ArchivoEmpresa {
  id: string;
  id_empresa: number;
  categoria: CategoriaArchivo;
  nombre: string;
  periodo: string;
  proveedor: ProveedorAlmacenamiento;
  /** Ruta relativa (LOCAL) o fileId (Drive) */
  referencia: string;
  url?: string;
  tamano_bytes: number;
  mime: string;
  sha256: string;
  creado_en: string;
  creado_por?: string;
}

export interface EmpresaRef {
  id_empresa: number;
  nit: string;
  nombre_comercial: string;
}

export interface ResultadoArchivo {
  ok: boolean;
  omitido?: boolean;
  /** El mismo contenido ya estaba archivado; se devuelve el registro existente */
  duplicado?: boolean;
  archivo?: ArchivoEmpresa;
  error?: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const archivadoPorDefecto = (): Record<CategoriaArchivo, boolean> =>
  LISTA_CATEGORIAS.reduce((acc, c) => ({ ...acc, [c]: true }), {} as Record<CategoriaArchivo, boolean>);

export const configPorDefecto = (idEmpresa: number): AlmacenamientoEmpresa => ({
  id_empresa: idEmpresa,
  proveedor: 'LOCAL',
  crear_carpeta_empresa: true,
  subcarpetas: {},
  organizar_por_periodo: true,
  archivado_automatico: archivadoPorDefecto(),
  estado: 'SIN_CONFIGURAR'
});

// ==========================================
// Utilidades
// ==========================================
export function slugCarpeta(texto: string): string {
  return (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .substring(0, 60) || 'empresa';
}

export function nombreArchivoSeguro(nombre: string): string {
  const limpio = (nombre || 'archivo')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.substring(0, 180) || 'archivo';
}

export function periodoActual(fecha: Date = new Date()): string {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

/** Extrae el ID de una URL de Google Drive (carpeta o unidad compartida) o devuelve el texto si ya es un ID. */
export function extraerIdDrive(entrada: string | undefined | null): string {
  const txt = (entrada || '').trim();
  if (!txt) return '';
  const patrones = [
    /\/folders\/([a-zA-Z0-9_-]{10,})/,
    /\/drive\/(?:u\/\d+\/)?shared-drives\/([a-zA-Z0-9_-]{10,})/,
    /[?&]id=([a-zA-Z0-9_-]{10,})/,
    /\/d\/([a-zA-Z0-9_-]{10,})/
  ];
  for (const p of patrones) {
    const m = txt.match(p);
    if (m) return m[1];
  }
  return /^[a-zA-Z0-9_-]{10,}$/.test(txt) ? txt : '';
}

const urlCarpeta = (id: string) => `https://drive.google.com/drive/folders/${id}`;

// ==========================================
// Cliente mínimo de Google Drive v3 (REST)
// ==========================================
type ModoCredencial = 'SERVICE_ACCOUNT' | 'OAUTH' | null;

export class GoogleDriveClient {
  private static jwt: JWT | null = null;
  private static oauth: OAuth2Client | null = null;

  static leerCuentaServicio(): any | null {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (raw && raw.trim()) {
      try {
        const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8');
        return JSON.parse(txt);
      } catch (e) {
        console.warn('[Almacenamiento] GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido.');
      }
    }
    const ruta = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (ruta && fs.existsSync(ruta)) {
      try {
        return JSON.parse(fs.readFileSync(ruta, 'utf-8'));
      } catch (e) {
        console.warn('[Almacenamiento] No se pudo leer GOOGLE_APPLICATION_CREDENTIALS.');
      }
    }
    return null;
  }

  static estadoCredenciales(): { modo: ModoCredencial; cuenta?: string; suplanta?: string } {
    const sa = this.leerCuentaServicio();
    if (sa?.client_email && sa?.private_key) {
      return { modo: 'SERVICE_ACCOUNT', cuenta: sa.client_email, suplanta: process.env.GOOGLE_DRIVE_IMPERSONATE || undefined };
    }
    if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
      return { modo: 'OAUTH', cuenta: process.env.GOOGLE_OAUTH_ACCOUNT_EMAIL || 'Cuenta OAuth configurada' };
    }
    return { modo: null };
  }

  private static async accessToken(): Promise<string> {
    const estado = this.estadoCredenciales();
    if (estado.modo === 'SERVICE_ACCOUNT') {
      if (!this.jwt) {
        const sa = this.leerCuentaServicio();
        this.jwt = new JWT({
          email: sa.client_email,
          key: sa.private_key,
          scopes: ['https://www.googleapis.com/auth/drive'],
          subject: process.env.GOOGLE_DRIVE_IMPERSONATE || undefined
        });
      }
      const t = await this.jwt.getAccessToken();
      if (!t.token) throw new Error('Google no devolvió un token de acceso para la cuenta de servicio.');
      return t.token;
    }
    if (estado.modo === 'OAUTH') {
      if (!this.oauth) {
        this.oauth = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
        this.oauth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
      }
      const t = await this.oauth.getAccessToken();
      if (!t.token) throw new Error('Google no devolvió un token de acceso OAuth.');
      return t.token;
    }
    throw new Error(
      'No hay credenciales de Google configuradas en el servidor. Defina GOOGLE_SERVICE_ACCOUNT_JSON (o GOOGLE_APPLICATION_CREDENTIALS) o las variables GOOGLE_OAUTH_*.'
    );
  }

  private static async llamar(url: string, init: RequestInit = {}, crudo = false): Promise<any> {
    const token = await this.accessToken();
    const res = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) }
    });
    if (!res.ok) {
      let detalle = `${res.status} ${res.statusText}`;
      try {
        const j: any = await res.json();
        detalle = j?.error?.message || detalle;
      } catch (_) {}
      if (/storage quota/i.test(detalle)) {
        detalle += ' — Las cuentas de servicio no tienen cuota en "Mi unidad": use una unidad compartida, OAuth, o GOOGLE_DRIVE_IMPERSONATE.';
      }
      throw new Error(`Google Drive: ${detalle}`);
    }
    if (crudo) return Buffer.from(await res.arrayBuffer());
    if (res.status === 204) return null;
    const tipo = res.headers.get('content-type') || '';
    if (tipo.includes('application/json')) return res.json();
    return Buffer.from(await res.arrayBuffer());
  }

  static async obtenerArchivo(id: string): Promise<{ id: string; name: string; mimeType: string; driveId?: string; webViewLink?: string }> {
    return this.llamar(`${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,driveId,webViewLink,trashed&supportsAllDrives=true`);
  }

  static async obtenerUnidad(id: string): Promise<{ id: string; name: string }> {
    return this.llamar(`${DRIVE_API}/drives/${encodeURIComponent(id)}?fields=id,name`);
  }

  static async buscarCarpetaHija(padreId: string, nombre: string, driveId?: string): Promise<string | null> {
    const q = `'${padreId}' in parents and name = '${nombre.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name)',
      pageSize: '10',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });
    if (driveId) {
      params.set('corpora', 'drive');
      params.set('driveId', driveId);
    }
    const r = await this.llamar(`${DRIVE_API}/files?${params.toString()}`);
    return r?.files?.[0]?.id || null;
  }

  static async crearCarpeta(padreId: string, nombre: string): Promise<string> {
    const r = await this.llamar(`${DRIVE_API}/files?supportsAllDrives=true&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nombre, mimeType: FOLDER_MIME, parents: [padreId] })
    });
    return r.id;
  }

  static async asegurarCarpeta(padreId: string, nombre: string, driveId?: string): Promise<string> {
    const existente = await this.buscarCarpetaHija(padreId, nombre, driveId);
    return existente || this.crearCarpeta(padreId, nombre);
  }

  static async subir(padreId: string, nombre: string, contenido: Buffer, mime: string): Promise<{ id: string; webViewLink?: string }> {
    const limite = `tlm_${crypto.randomBytes(8).toString('hex')}`;
    const meta = JSON.stringify({ name: nombre, parents: [padreId] });
    const cuerpo = Buffer.concat([
      Buffer.from(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      Buffer.from(`--${limite}\r\nContent-Type: ${mime}\r\n\r\n`),
      contenido,
      Buffer.from(`\r\n--${limite}--`)
    ]);
    return this.llamar(`${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${limite}` },
      body: cuerpo
    });
  }

  static async subirDesdeArchivo(padreId: string, nombre: string, filePath: string, mime: string, size: number): Promise<{ id: string; webViewLink?: string }> {
    const token = await this.accessToken();
    const meta = JSON.stringify({ name: nombre, parents: [padreId] });
    const inicio = await fetch(`${DRIVE_UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(size)
      },
      body: meta
    });
    if (!inicio.ok) throw new Error(`Google Drive no inició la carga: ${inicio.status} ${inicio.statusText}`);
    const urlCarga = inicio.headers.get('location');
    if (!urlCarga) throw new Error('Google Drive no devolvió la URL para continuar la carga.');

    return new Promise((resolve, reject) => {
      const request = https.request(urlCarga, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mime,
          'Content-Length': String(size)
        }
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
            reject(new Error(`Google Drive no pudo guardar el archivo: ${response.statusCode} ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('Google Drive devolvió una respuesta inválida al guardar el archivo.', { cause: err }));
          }
        });
      });
      request.on('error', reject);
      const source = fs.createReadStream(filePath);
      source.on('error', err => request.destroy(err));
      source.pipe(request);
    });
  }

  static async descargar(id: string): Promise<Buffer> {
    return this.llamar(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {}, true);
  }

  static async eliminar(id: string): Promise<void> {
    await this.llamar(`${DRIVE_API}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'DELETE' });
  }
}

// ==========================================
// Servicio principal
// ==========================================
class EmpresaStorageServiceImpl {
  private configs = new Map<number, AlmacenamientoEmpresa>();
  private archivos: ArchivoEmpresa[] = [];
  private cargado = false;
  private pgDisponible = false;
  private readonly archivoJson = path.resolve(process.cwd(), 'data', 'almacenamiento_empresas.json');

  get directorioLocalBase(): string {
    return path.resolve(process.env.TLM_STORAGE_DIR || path.join(process.cwd(), 'storage', 'empresas'));
  }

  // ---------- Persistencia (PostgreSQL + copia JSON local) ----------
  async inicializar(): Promise<void> {
    if (this.cargado) return;
    this.cargarDesdeJson();
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS empresa_almacenamiento (
        id_empresa INTEGER PRIMARY KEY,
        config JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS archivos_empresa (
        id TEXT PRIMARY KEY,
        id_empresa INTEGER NOT NULL,
        categoria TEXT NOT NULL,
        nombre TEXT NOT NULL,
        periodo TEXT,
        proveedor TEXT NOT NULL,
        referencia TEXT NOT NULL,
        url TEXT,
        tamano_bytes BIGINT DEFAULT 0,
        mime TEXT,
        sha256 TEXT,
        creado_en TEXT NOT NULL,
        creado_por TEXT
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_archivos_empresa_empresa ON archivos_empresa (id_empresa, categoria)`);
      this.pgDisponible = true;

      const cfgRows = await pool.query('SELECT id_empresa, config FROM empresa_almacenamiento');
      for (const r of cfgRows.rows) {
        this.configs.set(Number(r.id_empresa), this.normalizar({ ...r.config, id_empresa: Number(r.id_empresa) }));
      }
      const arRows = await pool.query('SELECT * FROM archivos_empresa ORDER BY creado_en DESC LIMIT 5000');
      if (arRows.rows.length > 0) {
        this.archivos = arRows.rows.map((r: any) => ({ ...r, id_empresa: Number(r.id_empresa), tamano_bytes: Number(r.tamano_bytes || 0) }));
      }
      this.guardarJson();
    } catch (err: any) {
      this.pgDisponible = false;
      console.warn('[Almacenamiento] PostgreSQL no disponible, se usa la copia local JSON:', err?.message || err);
    }
    this.cargado = true;
  }

  private cargarDesdeJson() {
    try {
      if (fs.existsSync(this.archivoJson)) {
        const dump = JSON.parse(fs.readFileSync(this.archivoJson, 'utf-8'));
        for (const c of dump.configs || []) this.configs.set(Number(c.id_empresa), this.normalizar(c));
        this.archivos = Array.isArray(dump.archivos) ? dump.archivos : [];
      }
    } catch (e) {
      console.warn('[Almacenamiento] No se pudo leer la copia JSON local.');
    }
  }

  private guardarJson() {
    try {
      fs.mkdirSync(path.dirname(this.archivoJson), { recursive: true });
      fs.writeFileSync(
        this.archivoJson,
        JSON.stringify({ configs: [...this.configs.values()], archivos: this.archivos.slice(0, 5000) }, null, 2)
      );
    } catch (e) {
      console.warn('[Almacenamiento] No se pudo escribir la copia JSON local.');
    }
  }

  private async persistirConfig(cfg: AlmacenamientoEmpresa) {
    this.configs.set(cfg.id_empresa, cfg);
    this.guardarJson();
    if (this.pgDisponible) {
      await pool
        .query(
          `INSERT INTO empresa_almacenamiento (id_empresa, config, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (id_empresa) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
          [cfg.id_empresa, JSON.stringify(cfg)]
        )
        .catch(err => console.warn('[Almacenamiento] Error guardando config en PostgreSQL:', err.message));
    }
  }

  private async persistirArchivo(a: ArchivoEmpresa) {
    this.archivos.unshift(a);
    this.guardarJson();
    if (this.pgDisponible) {
      await pool
        .query(
          `INSERT INTO archivos_empresa (id, id_empresa, categoria, nombre, periodo, proveedor, referencia, url, tamano_bytes, mime, sha256, creado_en, creado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
          [a.id, a.id_empresa, a.categoria, a.nombre, a.periodo, a.proveedor, a.referencia, a.url || null, a.tamano_bytes, a.mime, a.sha256, a.creado_en, a.creado_por || null]
        )
        .catch(err => console.warn('[Almacenamiento] Error registrando archivo en PostgreSQL:', err.message));
    }
  }

  private normalizar(c: Partial<AlmacenamientoEmpresa> & { id_empresa: number }): AlmacenamientoEmpresa {
    const base = configPorDefecto(c.id_empresa);
    return {
      ...base,
      ...c,
      subcarpetas: { ...(c.subcarpetas || {}) },
      archivado_automatico: { ...base.archivado_automatico, ...(c.archivado_automatico || {}) }
    } as AlmacenamientoEmpresa;
  }

  // ---------- Consulta ----------
  obtenerConfig(idEmpresa: number): AlmacenamientoEmpresa {
    return this.configs.get(idEmpresa) || configPorDefecto(idEmpresa);
  }

  listarConfigs(): AlmacenamientoEmpresa[] {
    return [...this.configs.values()];
  }

  listarArchivos(idEmpresa: number, categoria?: CategoriaArchivo, limite = 200): ArchivoEmpresa[] {
    return this.archivos
      .filter(a => a.id_empresa === idEmpresa && (!categoria || a.categoria === categoria))
      .slice(0, limite);
  }

  resumenArchivos(idEmpresa: number) {
    const propios = this.archivos.filter(a => a.id_empresa === idEmpresa);
    const porCategoria = LISTA_CATEGORIAS.reduce((acc, c) => {
      const lista = propios.filter(a => a.categoria === c);
      acc[c] = { cantidad: lista.length, bytes: lista.reduce((s, a) => s + (a.tamano_bytes || 0), 0) };
      return acc;
    }, {} as Record<CategoriaArchivo, { cantidad: number; bytes: number }>);
    return {
      total_archivos: propios.length,
      total_bytes: propios.reduce((s, a) => s + (a.tamano_bytes || 0), 0),
      ultimo_archivo: propios[0]?.creado_en,
      por_categoria: porCategoria
    };
  }

  credenciales() {
    return GoogleDriveClient.estadoCredenciales();
  }

  rutaLocalEmpresa(empresa: EmpresaRef): string {
    const nit = (empresa.nit || '').split('-')[0].replace(/[^\d]/g, '') || slugCarpeta(empresa.nit);
    return path.join(this.directorioLocalBase, `${nit}_${slugCarpeta(empresa.nombre_comercial)}`);
  }

  // ---------- Configuración ----------
  async guardarConfig(
    empresa: EmpresaRef,
    entrada: Partial<AlmacenamientoEmpresa> & { raiz?: string },
    usuario?: string
  ): Promise<AlmacenamientoEmpresa> {
    const previa = this.obtenerConfig(empresa.id_empresa);
    const proveedor = (entrada.proveedor || previa.proveedor || 'LOCAL') as ProveedorAlmacenamiento;
    const raizTexto = entrada.raiz ?? entrada.raiz_url ?? entrada.raiz_id ?? previa.raiz_url ?? previa.raiz_id;
    const raizId = proveedor === 'LOCAL' ? undefined : extraerIdDrive(raizTexto);

    if (proveedor !== 'LOCAL' && !raizId) {
      throw new Error('Pegue la URL o el ID de la carpeta / unidad compartida de Google Drive.');
    }

    const cambioDestino = proveedor !== previa.proveedor || raizId !== previa.raiz_id ||
      (entrada.crear_carpeta_empresa !== undefined && entrada.crear_carpeta_empresa !== previa.crear_carpeta_empresa);

    const cfg = this.normalizar({
      ...previa,
      id_empresa: empresa.id_empresa,
      proveedor,
      raiz_id: raizId,
      raiz_url: proveedor === 'LOCAL' ? undefined : (raizTexto?.startsWith('http') ? raizTexto : urlCarpeta(raizId!)),
      crear_carpeta_empresa: entrada.crear_carpeta_empresa ?? previa.crear_carpeta_empresa,
      organizar_por_periodo: entrada.organizar_por_periodo ?? previa.organizar_por_periodo,
      archivado_automatico: { ...previa.archivado_automatico, ...(entrada.archivado_automatico || {}) },
      subcarpetas: cambioDestino ? {} : previa.subcarpetas,
      carpeta_empresa_id: cambioDestino ? undefined : previa.carpeta_empresa_id,
      carpeta_empresa_url: cambioDestino ? undefined : previa.carpeta_empresa_url,
      estado: cambioDestino ? 'SIN_CONFIGURAR' : previa.estado,
      actualizado_por: usuario,
      actualizado_en: new Date().toISOString()
    });

    await this.persistirConfig(cfg);
    return cfg;
  }

  /** Verifica el destino y crea la estructura de carpetas de la empresa. */
  async inicializarEstructura(empresa: EmpresaRef, usuario?: string): Promise<AlmacenamientoEmpresa> {
    const cfg = this.obtenerConfig(empresa.id_empresa);
    try {
      if (cfg.proveedor === 'LOCAL') {
        const base = this.rutaLocalEmpresa(empresa);
        for (const c of LISTA_CATEGORIAS) {
          fs.mkdirSync(path.join(base, CATEGORIAS_ARCHIVO[c].carpeta), { recursive: true });
        }
        cfg.carpeta_empresa_id = path.relative(this.directorioLocalBase, base);
        cfg.carpeta_empresa_url = undefined;
        cfg.raiz_nombre = 'Servidor (almacenamiento local)';
        cfg.subcarpetas = LISTA_CATEGORIAS.reduce((acc, c) => ({ ...acc, [c]: CATEGORIAS_ARCHIVO[c].carpeta }), {});
      } else {
        const raizId = cfg.raiz_id!;
        let driveId: string | undefined;
        if (cfg.proveedor === 'GOOGLE_UNIDAD_COMPARTIDA') {
          const unidad = await GoogleDriveClient.obtenerUnidad(raizId);
          driveId = unidad.id;
          cfg.raiz_nombre = unidad.name;
        } else {
          const carpeta = await GoogleDriveClient.obtenerArchivo(raizId);
          if (carpeta.mimeType !== FOLDER_MIME) throw new Error('El ID indicado no corresponde a una carpeta.');
          driveId = carpeta.driveId;
          cfg.raiz_nombre = carpeta.name;
        }
        cfg.unidad_compartida_id = driveId;

        const carpetaEmpresa = cfg.crear_carpeta_empresa
          ? await GoogleDriveClient.asegurarCarpeta(raizId, `${empresa.nit} - ${empresa.nombre_comercial}`.substring(0, 120), driveId)
          : raizId;
        cfg.carpeta_empresa_id = carpetaEmpresa;
        cfg.carpeta_empresa_url = urlCarpeta(carpetaEmpresa);

        const sub: Partial<Record<CategoriaArchivo, string>> = {};
        for (const c of LISTA_CATEGORIAS) {
          sub[c] = await GoogleDriveClient.asegurarCarpeta(carpetaEmpresa, CATEGORIAS_ARCHIVO[c].carpeta, driveId);
        }
        cfg.subcarpetas = sub;
      }
      cfg.estado = 'CONECTADO';
      cfg.ultimo_error = undefined;
      cfg.verificado_en = new Date().toISOString();
      cfg.actualizado_por = usuario || cfg.actualizado_por;
    } catch (err: any) {
      cfg.estado = 'ERROR';
      cfg.ultimo_error = err?.message || String(err);
      cfg.verificado_en = new Date().toISOString();
      await this.persistirConfig(cfg);
      throw err;
    }
    await this.persistirConfig(cfg);
    return cfg;
  }

  // ---------- Archivado ----------
  /**
   * Guarda un archivo en el espacio de la empresa. Nunca lanza: devuelve { ok:false, error } si falla,
   * para que las funciones contables no se interrumpan por un problema de almacenamiento.
   */
  async archivar(params: {
    empresa: EmpresaRef;
    categoria: CategoriaArchivo;
    nombre: string;
    contenido?: Buffer;
    rutaContenido?: string;
    mime?: string;
    periodo?: string;
    usuario?: string;
    forzar?: boolean;
  }): Promise<ResultadoArchivo> {
    const { empresa, categoria } = params;
    let cfg = this.obtenerConfig(empresa.id_empresa);
    if (!params.forzar && cfg.archivado_automatico[categoria] === false) {
      return { ok: true, omitido: true };
    }

    try {
      if (!params.contenido && !params.rutaContenido) throw new Error('Debe indicar el contenido o la ruta del archivo que se va a archivar.');
      if (cfg.estado !== 'CONECTADO' || !cfg.subcarpetas[categoria]) {
        // Autoinicializa: en LOCAL siempre; en Drive solo si ya hay un destino definido
        if (cfg.proveedor === 'LOCAL' || cfg.raiz_id) {
          cfg = await this.inicializarEstructura(empresa, params.usuario);
        }
      }

      const periodo = params.periodo && /^\d{4}-\d{2}$/.test(params.periodo) ? params.periodo : periodoActual();
      const nombre = nombreArchivoSeguro(params.nombre);
      const mime = params.mime || 'application/octet-stream';
      const tamanoBytes = params.contenido
        ? params.contenido.length
        : (await fs.promises.stat(params.rutaContenido!)).size;
      const hash = crypto.createHash('sha256');
      if (params.contenido) {
        hash.update(params.contenido);
      } else {
        for await (const chunk of fs.createReadStream(params.rutaContenido!)) hash.update(chunk);
      }
      const sha256 = hash.digest('hex');

      // Mismo contenido ya archivado en esta categoría y destino → no se duplica
      const existente = this.archivos.find(a => a.id_empresa === empresa.id_empresa && a.categoria === categoria && a.sha256 === sha256 && a.proveedor === cfg.proveedor);
      if (existente) return { ok: true, archivo: existente, duplicado: true };
      let referencia = '';
      let url: string | undefined;

      if (cfg.proveedor === 'LOCAL') {
        const dir = path.join(
          this.rutaLocalEmpresa(empresa),
          CATEGORIAS_ARCHIVO[categoria].carpeta,
          cfg.organizar_por_periodo ? periodo : ''
        );
        fs.mkdirSync(dir, { recursive: true });
        let destino = path.join(dir, nombre);
        if (fs.existsSync(destino)) {
          const ext = path.extname(nombre);
          destino = path.join(dir, `${path.basename(nombre, ext)}_${Date.now()}${ext}`);
        }
        if (params.contenido) fs.writeFileSync(destino, params.contenido);
        else await fs.promises.copyFile(params.rutaContenido!, destino);
        referencia = path.relative(this.directorioLocalBase, destino);
      } else {
        const carpetaCategoria = cfg.subcarpetas[categoria];
        if (!carpetaCategoria) throw new Error('La estructura de carpetas de la empresa no está inicializada.');
        const padre = cfg.organizar_por_periodo
          ? await GoogleDriveClient.asegurarCarpeta(carpetaCategoria, periodo, cfg.unidad_compartida_id)
          : carpetaCategoria;
        const subido = params.contenido
          ? await GoogleDriveClient.subir(padre, nombre, params.contenido, mime)
          : await GoogleDriveClient.subirDesdeArchivo(padre, nombre, params.rutaContenido!, mime, tamanoBytes);
        referencia = subido.id;
        url = subido.webViewLink;
      }

      const archivo: ArchivoEmpresa = {
        id: `ARC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        id_empresa: empresa.id_empresa,
        categoria,
        nombre: path.basename(referencia.includes(path.sep) ? referencia : nombre),
        periodo,
        proveedor: cfg.proveedor,
        referencia,
        url,
        tamano_bytes: tamanoBytes,
        mime,
        sha256,
        creado_en: new Date().toISOString(),
        creado_por: params.usuario
      };
      await this.persistirArchivo(archivo);
      return { ok: true, archivo };
    } catch (err: any) {
      const mensaje = err?.message || String(err);
      console.warn(`[Almacenamiento] No se pudo archivar "${params.nombre}" para la empresa ${empresa.nit}:`, mensaje);
      return { ok: false, error: mensaje };
    }
  }

  /** Lee el contenido de un archivo archivado (solo si pertenece a la empresa indicada). */
  async leerArchivo(idEmpresa: number, idArchivo: string): Promise<{ archivo: ArchivoEmpresa; contenido: Buffer }> {
    const archivo = this.archivos.find(a => a.id === idArchivo && a.id_empresa === idEmpresa);
    if (!archivo) throw new Error('Archivo no encontrado para esta empresa.');
    if (archivo.proveedor === 'LOCAL') {
      const ruta = path.resolve(this.directorioLocalBase, archivo.referencia);
      if (!ruta.startsWith(this.directorioLocalBase + path.sep)) throw new Error('Ruta de archivo no permitida.');
      return { archivo, contenido: fs.readFileSync(ruta) };
    }
    return { archivo, contenido: await GoogleDriveClient.descargar(archivo.referencia) };
  }

  async eliminarArchivo(idEmpresa: number, idArchivo: string): Promise<void> {
    const idx = this.archivos.findIndex(a => a.id === idArchivo && a.id_empresa === idEmpresa);
    if (idx === -1) throw new Error('Archivo no encontrado para esta empresa.');
    const archivo = this.archivos[idx];
    if (archivo.proveedor === 'LOCAL') {
      const ruta = path.resolve(this.directorioLocalBase, archivo.referencia);
      if (ruta.startsWith(this.directorioLocalBase + path.sep) && fs.existsSync(ruta)) fs.unlinkSync(ruta);
    } else {
      await GoogleDriveClient.eliminar(archivo.referencia);
    }
    this.archivos.splice(idx, 1);
    this.guardarJson();
    if (this.pgDisponible) {
      await pool.query('DELETE FROM archivos_empresa WHERE id = $1', [idArchivo]).catch(() => {});
    }
  }
}

export const EmpresaStorageService = new EmpresaStorageServiceImpl();
