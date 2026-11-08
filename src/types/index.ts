export interface Empresa {
  id_empresa: number;
  nombre_comercial: string;
  nit: string;
  software_erp: string;
  software_destino: string;
  logo_url?: string;
  siigo_username?: string;
  siigo_access_key?: string;
  siigo_document_id?: number;
}

export interface PermisosUsuario {
  administrador: boolean;
  auditoria_ubl: boolean;
  impuestos_f350: boolean;
  conciliacion_bancaria: boolean;
  transmitir_siigo: boolean;
  gestion_usuarios: boolean;
  base_datos?: boolean;
  arquitectura_escala?: boolean;
}

export interface NotificacionSeguridad {
  id: string;
  destinatario: string;
  asunto: string;
  fecha: string;
  tipo: 'NUEVO_USUARIO' | 'RESET_ADMIN' | 'CODIGO_RECUPERACION' | 'PASSWORD_CAMBIADA' | 'ACCESO_CODIGO_DESARROLLADOR' | 'CUENTA_APROBADA';
  codigo_otp?: string;
  mensaje: string;
  /** PENDIENTE mientras sale el correo; SIMULADO si no hay proveedor de correo configurado */
  estado: 'ENVIADO' | 'PENDIENTE' | 'SIMULADO' | 'ERROR';
  error?: string;
}

export interface PermisosCodigo {
  editar_codigo: boolean;
  hacer_commits_git: boolean;
  desplegar_cloud_run: boolean;
  acceso_google_drive: boolean;
  gestionar_apis_dian: boolean;
}

export interface DesarrolladorAcceso {
  id: string;
  email: string;
  nombre: string;
  rol_tecnico: 'Full-Stack Developer' | 'Frontend Engineer' | 'Backend Engineer' | 'DevOps & Cloud Engineer' | 'Auditor de Código';
  estado: 'ACTIVO' | 'INVITADO' | 'REVOCADO';
  token_desarrollador: string;
  permisos_codigo: PermisosCodigo;
  fecha_invitacion: string;
  ultimo_acceso?: string;
  invitado_por: string;
}

export interface Usuario {
  id_usuario: number;
  nombre_completo: string;
  email: string;
  rol: 'Administrador' | 'Contador' | 'Analista' | 'Auditor' | 'Desarrollador';
  activo: boolean;
  empresas_ids: number[];
  permisos?: PermisosUsuario;
  avatar_url?: string | null;
  requiere_cambio_password?: boolean;
  codigo_recuperacion?: string | null;
  codigo_recuperacion_expira?: string | null;
  verification_token?: string | null;
  token_expires_at?: string | null;
  email_verified?: boolean;
  ultimo_cambio_password?: string;
}

export interface Factura {
  id_factura: number;
  id_empresa: number;
  factura_num: string;
  fecha: string;
  fecha_vencimiento?: string;
  proveedor: string;
  nit_tercero: string;
  telefono?: string;
  direccion?: string;
  ciudad?: string;
  departamento?: string;
  correo?: string;
  descripcion_item: string;
  cantidad: number;
  valor_unitario: number;
  subtotal: number;
  iva: number;
  total?: number;
  casilla_350: number;
  retencion_porc: number;
  retencion_valor: number;
  reteica_tarifa?: number;
  reteiva_porc?: number;
  forma_pago: string;
  medio_pago: string;
  cuenta_gasto: string;
  tipo_comprobante: string;
  cufe_hash: string;
  estado_revision: 'PENDIENTE' | 'AUDITADA' | 'RECHAZADA' | 'SINCRONIZADA_SIIGO';
  fecha_cargue: string;
  siigo_id?: string;
  tipo_operacion?: 'VENTA' | 'COMPRA';
  banco_siigo?: string;
  id_medio_pago?: number | null;
  id_retencion?: number | null;
  id_reteica?: number | null;
  id_reteiva?: number | null;
  items?: FacturaItem[];
  datos_ubl?: {
    emisor?: ParteFactura;
    adquiriente?: ParteFactura;
    tipo_operacion_dian?: string;
    moneda?: string;
    archivo_origen?: string;
  };
}

export interface FacturaItem {
  linea: number;
  codigo?: string;
  descripcion_item: string;
  unidad?: string;
  cantidad: number;
  valor_unitario: number;
  descuento?: number;
  subtotal: number;
  iva: number;
  iva_porc?: number;
  inc?: number;
  cuenta_contable?: string;
}

export interface ParteFactura {
  nit: string;
  razon_social: string;
  nombre_comercial?: string;
  tipo_contribuyente?: string;
  regimen_fiscal?: string;
  responsabilidad_tributaria?: string;
  direccion?: string;
  ciudad?: string;
  departamento?: string;
  telefono?: string;
  correo?: string;
}

// ==========================================
// Almacenamiento documental por empresa
// ==========================================
export type ProveedorAlmacenamiento = 'LOCAL' | 'GOOGLE_DRIVE_CARPETA' | 'GOOGLE_UNIDAD_COMPARTIDA';
export type CategoriaArchivo = 'FACTURAS_XML' | 'SOPORTES_PDF' | 'AUDITORIA' | 'EXPORTES_ERP' | 'CONCILIACIONES' | 'CEREBRO_CONTABLE' | 'RESPALDOS';

export interface AlmacenamientoEmpresa {
  id_empresa: number;
  proveedor: ProveedorAlmacenamiento;
  raiz_id?: string;
  raiz_url?: string;
  raiz_nombre?: string;
  crear_carpeta_empresa: boolean;
  carpeta_empresa_id?: string;
  carpeta_empresa_url?: string;
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
  url?: string;
  tamano_bytes: number;
  mime: string;
  creado_en: string;
  creado_por?: string;
}

/** Resultado de archivado que devuelven las funciones contables */
export interface ResultadoArchivado {
  ok: boolean;
  omitido?: boolean;
  error?: string;
  archivo?: ArchivoEmpresa;
}

export interface CuentaPUC {
  id_puc: number;
  id_empresa: number;
  cuenta: string;
  nombre: string;
}

export interface BalanceTercero {
  id_balance: number;
  id_empresa: number;
  cuenta_contable: string;
  nombre_cuenta: string;
  nit_tercero: string;
  nombre_tercero: string;
  saldo_inicial: number;
  debitos: number;
  creditos: number;
  saldo_final: number;
}

export interface F350Casilla {
  casilla: number;
  concepto: string;
  base_gravable: number;
  tarifa_sugerida: number;
  retencion_calculada: number;
  cantidad_facturas: number;
  facturas_asociadas: string[];
}

export interface F350Report {
  periodo: string;
  anoGravable: number;
  totalBasesGravables: number;
  totalRetenciones: number;
  totalReteIva: number;
  totalReteIca: number;
  granTotalRetenido: number;
  casillas: F350Casilla[];
}

export interface MovimientoBancario {
  id: string;
  fecha: string;
  concepto: string;
  monto: number;
  tipo: 'DEBITO' | 'CREDITO';
  conciliado: boolean;
  match_id?: string;
}

export interface MovimientoLibro {
  id: string;
  fecha: string;
  concepto: string;
  monto: number;
  tipo: 'DEBITO' | 'CREDITO';
  cuenta: string;
  tercero?: string;
  conciliado: boolean;
  match_id?: string;
}

export interface CruceConciliacion {
  id_cruce: string;
  banco: MovimientoBancario;
  libro: MovimientoLibro;
  diferencia: number;
  puntaje_coincidencia: number;
  metodo_match: 'EXACTO' | 'TOLERANCIA_VALOR' | 'APROX_FECHA_VALOR';
}

export interface ConciliacionSummary {
  totalBanco: number;
  totalLibros: number;
  partidasConciliadas: number;
  partidasPendientesBanco: number;
  partidasPendientesLibros: number;
  diferenciaNeta: number;
  tasaCoincidencia: number;
  cruces: CruceConciliacion[];
  pendientesBanco: MovimientoBancario[];
  pendientesLibro: MovimientoLibro[];
}

export interface ModificacionRepositorio {
  id: string;
  timestamp: string;
  autor_id: number;
  autor_nombre: string;
  autor_email: string;
  autor_rol: string;
  tipo_accion: 'FACTURA_UPDATE' | 'FACTURA_AUDITADA' | 'CONCILIACION' | 'PUC_UPDATE' | 'CONFIG_UPDATE' | 'COLABORACION' | 'RELEASE_V2' | 'GCP_SYNC';
  descripcion: string;
  detalles?: string;
  version_destino: string; // "v2.0"
  repositorio: string; // "Repositorio Maestro de Juan Yaya"
  hash_commit: string;
}

export interface RepositorioInfo {
  nombre: string;
  propietario: string;
  email_propietario: string;
  version_actual: string;
  tag: string;
  descripcion: string;
  canal_sincronizacion: string;
  colaboradores_conectados: number;
  total_modificaciones: number;
  ultima_actualizacion: string;
}

export interface GoogleDriveFile {
  id: string;
  nombre: string;
  tipo: 'xml' | 'json' | 'csv' | 'pdf' | 'xlsx' | 'folder';
  tamano_bytes: number;
  tamano_legible: string;
  ultima_modificacion: string;
  sincronizado: boolean;
  drive_url: string;
  categoria: 'FACTURAS_XML' | 'EXTRACTOS' | 'BACKUPS_BD' | 'REPORTES_F350' | 'PLANOS_SIIGO' | 'EXCEL_BD';
}

export interface GoogleDriveConfig {
  cuenta_propietario: string;
  carpeta_id: string;
  carpeta_nombre: string;
  carpeta_url: string;
  modo_sincronizacion: 'AUTOMATICA_TIEMPO_REAL' | 'MANUAL';
  ultima_sincronizacion: string;
  hash_ultimo_sync: string;
}

export interface GoogleDriveStatus {
  conectado: boolean;
  cuenta_propietario: string;
  carpeta_id: string;
  carpeta_nombre: string;
  carpeta_url: string;
  espacio_usado_gb: number;
  espacio_total_gb: number;
  porcentaje_usado: number;
  total_archivos: number;
  archivos_xml_ubl: number;
  backups_json: number;
  ultima_sincronizacion: string;
  hash_ultimo_sync: string;
  archivos: GoogleDriveFile[];
  modo_sincronizacion: 'AUTOMATICA_TIEMPO_REAL' | 'MANUAL';
  estado: 'ACTIVO_Y_SINCRONIZADO' | 'SINCRONIZANDO' | 'ERROR';
}
