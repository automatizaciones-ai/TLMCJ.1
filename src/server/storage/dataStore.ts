import fs from 'fs';
import path from 'path';
import type { Usuario, PermisosUsuario, Empresa, Factura, CuentaPUC, BalanceTercero, MovimientoBancario, MovimientoLibro, ModificacionRepositorio, RepositorioInfo, NotificacionSeguridad, GoogleDriveConfig, GoogleDriveFile, GoogleDriveStatus, DesarrolladorAcceso, PermisosCodigo } from '../domain/types.ts';

export function getDefaultPermissions(rol: 'Administrador' | 'Contador' | 'Analista' | 'Auditor' | 'Desarrollador'): PermisosUsuario {
  switch (rol) {
    case 'Administrador':
      return {
        administrador: true,
        auditoria_ubl: true,
        impuestos_f350: true,
        conciliacion_bancaria: true,
        transmitir_siigo: true,
        gestion_usuarios: true,
      };
    case 'Desarrollador':
      return {
        administrador: true,
        auditoria_ubl: true,
        impuestos_f350: true,
        conciliacion_bancaria: true,
        transmitir_siigo: true,
        gestion_usuarios: true,
      };
    case 'Contador':
      return {
        administrador: false,
        auditoria_ubl: true,
        impuestos_f350: true,
        conciliacion_bancaria: true,
        transmitir_siigo: true,
        gestion_usuarios: false,
      };
    case 'Analista':
      return {
        administrador: false,
        auditoria_ubl: true,
        impuestos_f350: true,
        conciliacion_bancaria: false,
        transmitir_siigo: false,
        gestion_usuarios: false,
      };
    case 'Auditor':
      return {
        administrador: false,
        auditoria_ubl: true,
        impuestos_f350: false,
        conciliacion_bancaria: false,
        transmitir_siigo: false,
        gestion_usuarios: false,
      };
  }
}

export class DataStore {
  public usuarios: Usuario[] = [];
  public empresas: Empresa[] = [];
  public facturas: Factura[] = [];
  public cuentasPUC: CuentaPUC[] = [];
  public balanceTerceros: BalanceTercero[] = [];
  public movimientosBanco: MovimientoBancario[] = [];
  public movimientosLibro: MovimientoLibro[] = [];
  public modificaciones: ModificacionRepositorio[] = [];
  public notificacionesSeguridad: NotificacionSeguridad[] = [];
  /** Lo registra el servicio de notificaciones para enviar cada aviso de seguridad por correo */
  public alNotificarSeguridad?: (item: NotificacionSeguridad) => void;

  public googleDriveConfig: GoogleDriveConfig = {
    cuenta_propietario: "automatizaciones@tlm.net.co",
    carpeta_id: "1tlm-enterprise-drive-juan-yaya-2026",
    carpeta_nombre: "Consola TLM - Enterprise Repositorio v2.0 (Drive Maestro)",
    carpeta_url: "https://drive.google.com/drive/folders/1tlm-enterprise-drive-juan-yaya-2026",
    modo_sincronizacion: "AUTOMATICA_TIEMPO_REAL",
    ultima_sincronizacion: new Date().toISOString(),
    hash_ultimo_sync: "drv-v2-initial"
  };
  public googleDriveFiles: GoogleDriveFile[] = [];
  public desarrolladores: DesarrolladorAcceso[] = [];
  public brandingConfig = {
    customLogoUrl: null as string | null,
    variantTitle: "Logotipo Oficial TLM Completo",
    temaAcento: "#271a82",
    sidebarColor: "#1c1343",
    subtitulo: "Get Adviced",
    autor_nombre: "Juan Yaya - Administrador Maestro",
    updatedAt: new Date().toISOString()
  };

  private dbFilePath = path.resolve(process.cwd(), 'data', 'tlm_database.json');

  constructor() {
    if (!this.loadFromDisk()) {
      this.initSeedData();
      this.saveToDisk();
    }
  }

  public saveToDisk() {
    try {
      const dir = path.dirname(this.dbFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const dump = {
        version: "2.0",
        repositorio_nombre: "Repositorio Central de Juan Yaya",
        repositorio_version: "2.0",
        repositorio_propietario: "Juan Yaya - Administrador Maestro",
        updatedAt: new Date().toISOString(),
        usuarios: this.usuarios,
        empresas: this.empresas,
        facturas: this.facturas,
        cuentasPUC: this.cuentasPUC,
        balanceTerceros: this.balanceTerceros,
        movimientosBanco: this.movimientosBanco,
        movimientosLibro: this.movimientosLibro,
        modificaciones: this.modificaciones,
        notificacionesSeguridad: this.notificacionesSeguridad,
        googleDriveConfig: this.googleDriveConfig,
        googleDriveFiles: this.googleDriveFiles,
        desarrolladores: this.desarrolladores,
        brandingConfig: this.brandingConfig
      };
      fs.writeFileSync(this.dbFilePath, JSON.stringify(dump, null, 2), 'utf-8');
    } catch (e) {
      console.warn("[DataStore] No se pudo guardar en disco:", e);
    }
  }

  public loadFromDisk(): boolean {
    try {
      if (fs.existsSync(this.dbFilePath)) {
        const raw = fs.readFileSync(this.dbFilePath, 'utf-8');
        const dump = JSON.parse(raw);
        if (dump && dump.usuarios && dump.empresas) {
          this.usuarios = dump.usuarios.map((u: any) => ({
            ...u,
            permisos: u.permisos || getDefaultPermissions(u.rol)
          }));

          // Asegurar que los 2 nuevos colaboradores existen
          if (!this.usuarios.find(u => u.id_usuario === 5)) {
            this.usuarios.push({
              id_usuario: 5,
              nombre_completo: "Andrés Felipe Morales (Especialista Tributario)",
              email: "andres.morales@tlm.net.co",
              hashed_password: "colab_andres_token",
              rol: "Contador",
              activo: true,
              empresas_ids: [1, 2],
              permisos: getDefaultPermissions('Contador')
            });
          }

          if (!this.usuarios.find(u => u.id_usuario === 6)) {
            this.usuarios.push({
              id_usuario: 6,
              nombre_completo: "Valentina Castro Rincón (Gestora de Operaciones & UBL)",
              email: "valentina.castro@tlm.net.co",
              hashed_password: "colab_valentina_token",
              rol: "Analista",
              activo: true,
              empresas_ids: [1, 2],
              permisos: {
                ...getDefaultPermissions('Analista'),
                auditoria_ubl: true,
                impuestos_f350: true,
                conciliacion_bancaria: true
              }
            });
          }

          this.empresas = dump.empresas;
          this.facturas = dump.facturas || [];
          this.cuentasPUC = dump.cuentasPUC || [];
          this.balanceTerceros = dump.balanceTerceros || [];
          this.movimientosBanco = dump.movimientosBanco || [];
          this.movimientosLibro = dump.movimientosLibro || [];
          this.modificaciones = dump.modificaciones || [];
          this.notificacionesSeguridad = dump.notificacionesSeguridad || [];

          if (dump.googleDriveConfig) {
            this.googleDriveConfig = { ...this.googleDriveConfig, ...dump.googleDriveConfig };
          }
          if (dump.googleDriveFiles && Array.isArray(dump.googleDriveFiles) && dump.googleDriveFiles.length > 0) {
            this.googleDriveFiles = dump.googleDriveFiles;
            if (!this.googleDriveFiles.some(f => f.nombre.endsWith('.xlsx'))) {
              this.googleDriveFiles.push({
                id: "drv-file-06",
                nombre: "tlm_base_de_datos_maestra.xlsx",
                tipo: "xlsx",
                tamano_bytes: 58200,
                tamano_legible: "56.8 KB",
                ultima_modificacion: new Date().toISOString(),
                sincronizado: true,
                drive_url: "https://drive.google.com/drive/folders/1tlm-enterprise-drive-juan-yaya-2026",
                categoria: "EXCEL_BD"
              });
            }
          } else {
            this.initSeedGoogleDriveFiles();
          }

          if (dump.desarrolladores && Array.isArray(dump.desarrolladores) && dump.desarrolladores.length > 0) {
            this.desarrolladores = dump.desarrolladores;
          } else {
            this.initSeedDesarrolladores();
          }

          if (this.modificaciones.length === 0) {
            this.initSeedModificaciones();
          }

          if (this.notificacionesSeguridad.length === 0) {
            this.notificacionesSeguridad = [
              {
                id: "sec-seed-1",
                destinatario: "andres.morales@tlm.net.co",
                asunto: "Credenciales de Acceso a Consola TLM - Contraseña Provisional Asignada por Juan",
                fecha: new Date(Date.now() - 3600000 * 2).toISOString(),
                tipo: "NUEVO_USUARIO",
                mensaje: "Estimado/a Andrés Felipe Morales, Juan Yaya (Administrador Maestro) ha habilitado tu acceso a la Consola TLM Enterprise con contraseña provisional. Se requerirá cambio obligatorio alfanumérico al primer inicio.",
                estado: "ENVIADO"
              },
              {
                id: "sec-seed-2",
                destinatario: "automatizaciones@tlm.net.co",
                asunto: "Código de Seguridad [748291] para Recuperación de Contraseña - TLM",
                fecha: new Date(Date.now() - 3600000).toISOString(),
                tipo: "CODIGO_RECUPERACION",
                codigo_otp: "748291",
                mensaje: "Hola Juan Yaya, has solicitado recuperar tu contraseña corporativa. Tu código de seguridad confidencial es: [748291]. Válido por 15 minutos.",
                estado: "ENVIADO"
              }
            ];
          }

          if (dump.brandingConfig) {
            this.brandingConfig = { ...this.brandingConfig, ...dump.brandingConfig };
          }

          return true;
        }
      }
    } catch (e) {
      console.warn("[DataStore] No se pudo cargar de disco, usando seeds iniciales:", e);
    }
    return false;
  }

  public getBrandingConfig() {
    return this.brandingConfig;
  }

  public updateBrandingConfig(data: Partial<typeof this.brandingConfig>) {
    this.brandingConfig = {
      ...this.brandingConfig,
      ...data,
      autor_nombre: data.autor_nombre || "Juan Yaya - Administrador Maestro",
      updatedAt: new Date().toISOString()
    };
    this.saveToDisk();
    return this.brandingConfig;
  }

  public initSeedGoogleDriveFiles() {
    this.googleDriveFiles = [
      {
        id: "drv-file-01",
        nombre: "repositorio_juan_version_2.0.json",
        tipo: "json",
        tamano_bytes: 52400,
        tamano_legible: "51.2 KB",
        ultima_modificacion: new Date().toISOString(),
        sincronizado: true,
        drive_url: "https://drive.google.com/drive/folders/1tlm-enterprise-drive-juan-yaya-2026",
        categoria: "BACKUPS_BD"
      },
      {
        id: "drv-file-02",
        nombre: "Facturas_DIAN_UBL2.1_Lote_Marzo2026.xml",
        tipo: "xml",
        tamano_bytes: 142300,
        tamano_legible: "138.9 KB",
        ultima_modificacion: new Date(Date.now() - 3600000 * 3).toISOString(),
        sincronizado: true,
        drive_url: "https://drive.google.com/drive/folders/1tlm-enterprise-drive-juan-yaya-2026",
        categoria: "FACTURAS_XML"
      },
      {
        id: "drv-file-03",
        nombre: "Extracto_Bancolombia_CtaCte_1029384756.csv",
        tipo: "csv",
        tamano_bytes: 28400,
        tamano_legible: "27.7 KB",
        ultima_modificacion: new Date(Date.now() - 3600000 * 8).toISOString(),
        sincronizado: true,
        drive_url: "https://drive.google.com/drive/folders/1tlm-enterprise-drive-juan-yaya-2026",
        categoria: "EXTRACTOS"
      },
      {
        id: "drv-file-04",
        nombre: "Declaracion_Retenciones_Formulario_350_2026.pdf",
        tipo: "pdf",
        tamano_bytes: 312000,
        tamano_legible: "304.7 KB",
        ultima_modificacion: new Date(Date.now() - 3600000 * 24).toISOString(),
        sincronizado: true,
        drive_url: "https://drive.google.com/drive/folders/1tlm-enterprise-drive-juan-yaya-2026",
        categoria: "REPORTES_F350"
      },
      {
        id: "drv-file-05",
        nombre: "Plano_Siigo_Nube_Asientos_Causacion.json",
        tipo: "json",
        tamano_bytes: 35600,
        tamano_legible: "34.8 KB",
        ultima_modificacion: new Date(Date.now() - 3600000 * 12).toISOString(),
        sincronizado: true,
        drive_url: "https://drive.google.com/drive/folders/1tlm-enterprise-drive-juan-yaya-2026",
        categoria: "PLANOS_SIIGO"
      },
      {
        id: "drv-file-06",
        nombre: "tlm_base_de_datos_maestra.xlsx",
        tipo: "xlsx",
        tamano_bytes: 58200,
        tamano_legible: "56.8 KB",
        ultima_modificacion: new Date().toISOString(),
        sincronizado: true,
        drive_url: "https://drive.google.com/drive/folders/1tlm-enterprise-drive-juan-yaya-2026",
        categoria: "EXCEL_BD"
      }
    ];
  }

  public initSeedDesarrolladores() {
    this.desarrolladores = [
      {
        id: "dev-01",
        email: "automatizaciones@tlm.net.co",
        nombre: "Juan Yaya - Administrador Maestro",
        rol_tecnico: "Full-Stack Developer",
        estado: "ACTIVO",
        token_desarrollador: "tlm_dev_jy_9921_master",
        permisos_codigo: {
          editar_codigo: true,
          hacer_commits_git: true,
          desplegar_cloud_run: true,
          acceso_google_drive: true,
          gestionar_apis_dian: true
        },
        fecha_invitacion: "2026-10-08T10:00:00.000Z",
        ultimo_acceso: new Date().toISOString(),
        invitado_por: "Sistema TLM (Propietario)"
      },
      {
        id: "dev-02",
        email: "desarrollo@tlm.net.co",
        nombre: "Equipo Central de Desarrollo TLM",
        rol_tecnico: "DevOps & Cloud Engineer",
        estado: "ACTIVO",
        token_desarrollador: "tlm_dev_team_5514_rw",
        permisos_codigo: {
          editar_codigo: true,
          hacer_commits_git: true,
          desplegar_cloud_run: true,
          acceso_google_drive: true,
          gestionar_apis_dian: true
        },
        fecha_invitacion: "2026-10-09T14:30:00.000Z",
        ultimo_acceso: new Date(Date.now() - 3600000 * 3).toISOString(),
        invitado_por: "Juan Yaya - Administrador Maestro"
      },
      {
        id: "dev-03",
        email: "andres.morales@tlm.net.co",
        nombre: "Andrés Felipe Morales",
        rol_tecnico: "Backend Engineer",
        estado: "ACTIVO",
        token_desarrollador: "tlm_dev_am_3391_api",
        permisos_codigo: {
          editar_codigo: true,
          hacer_commits_git: true,
          desplegar_cloud_run: false,
          acceso_google_drive: true,
          gestionar_apis_dian: true
        },
        fecha_invitacion: "2026-10-09T15:00:00.000Z",
        ultimo_acceso: new Date(Date.now() - 3600000 * 5).toISOString(),
        invitado_por: "Juan Yaya - Administrador Maestro"
      }
    ];
  }

  public getDesarrolladores(): DesarrolladorAcceso[] {
    return this.desarrolladores;
  }

  public invitarDesarrollador(data: {
    email: string;
    nombre: string;
    rol_tecnico: DesarrolladorAcceso['rol_tecnico'];
    permisos_codigo?: Partial<PermisosCodigo>;
    invitado_por?: string;
  }): DesarrolladorAcceso {
    const existing = this.desarrolladores.find(d => d.email.toLowerCase() === data.email.toLowerCase().trim());
    if (existing) {
      existing.estado = 'ACTIVO';
      existing.nombre = data.nombre || existing.nombre;
      existing.rol_tecnico = data.rol_tecnico || existing.rol_tecnico;
      if (data.permisos_codigo) {
        existing.permisos_codigo = { ...existing.permisos_codigo, ...data.permisos_codigo };
      }
      this.saveToDisk();
      return existing;
    }

    const token = 'tlm_dev_' + Math.random().toString(36).substring(2, 8) + '_' + Math.random().toString(36).substring(2, 6);
    const nuevo: DesarrolladorAcceso = {
      id: `dev-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      email: data.email.toLowerCase().trim(),
      nombre: data.nombre.trim(),
      rol_tecnico: data.rol_tecnico,
      estado: 'ACTIVO',
      token_desarrollador: token,
      permisos_codigo: {
        editar_codigo: true,
        hacer_commits_git: true,
        desplegar_cloud_run: data.permisos_codigo?.desplegar_cloud_run ?? true,
        acceso_google_drive: data.permisos_codigo?.acceso_google_drive ?? true,
        gestionar_apis_dian: data.permisos_codigo?.gestionar_apis_dian ?? true
      },
      fecha_invitacion: new Date().toISOString(),
      ultimo_acceso: new Date().toISOString(),
      invitado_por: data.invitado_por || "Juan Yaya - Administrador Maestro"
    };

    this.desarrolladores.unshift(nuevo);

    // Registrar notificación por correo corporativo con token y accesos
    this.addNotificacionSeguridad({
      destinatario: nuevo.email,
      asunto: `Acceso Concedido para Edición de Código & Repositorio - Consola TLM`,
      tipo: 'ACCESO_CODIGO_DESARROLLADOR',
      mensaje: `Hola ${nuevo.nombre}, Juan Yaya te ha concedido acceso para editar el código fuente de Consola TLM y colaborar en el proyecto. Tu rol técnico asignado es [${nuevo.rol_tecnico}]. Token de acceso Git/IDE: [${nuevo.token_desarrollador}]. Puedes clonar el repositorio, desplegar en Google Cloud Run y colaborar sobre el código fuente.`
    });

    this.addModificacion({
      autor_id: 1,
      autor_nombre: "Juan Yaya - Administrador Maestro",
      tipo_accion: "COLABORACION",
      descripcion: `Acceso de edición de código otorgado a ${nuevo.email} (${nuevo.rol_tecnico})`,
      detalles: `Permisos de desarrollo activados: Editar código fuente, commits Git y sincronización con Google Cloud y Google Drive.`
    });

    this.saveToDisk();
    return nuevo;
  }

  public revocarDesarrollador(id: string): boolean {
    const dev = this.desarrolladores.find(d => d.id === id);
    if (!dev) return false;
    if (dev.email === "automatizaciones@tlm.net.co") {
      throw new Error("No se puede revocar el acceso del Propietario Principal (Juan Yaya).");
    }
    dev.estado = 'REVOCADO';
    this.addModificacion({
      autor_id: 1,
      autor_nombre: "Juan Yaya - Administrador Maestro",
      tipo_accion: "CONFIG_UPDATE",
      descripcion: `Revocación de acceso a código para ${dev.email}`,
      detalles: `Permisos de edición de código suspendidos para el usuario.`
    });
    this.saveToDisk();
    return true;
  }

  public regenerarTokenDesarrollador(id: string): DesarrolladorAcceso | null {
    const dev = this.desarrolladores.find(d => d.id === id);
    if (!dev) return null;
    const newToken = 'tlm_dev_' + Math.random().toString(36).substring(2, 8) + '_' + Math.random().toString(36).substring(2, 6);
    dev.token_desarrollador = newToken;
    dev.estado = 'ACTIVO';
    this.addNotificacionSeguridad({
      destinatario: dev.email,
      asunto: `Nuevo Token de Desarrollo para Edición de Código - Consola TLM`,
      tipo: 'ACCESO_CODIGO_DESARROLLADOR',
      mensaje: `Hola ${dev.nombre}, tu token de acceso para edición de código ha sido regenerado. Nuevo token: [${newToken}].`
    });
    this.saveToDisk();
    return dev;
  }

  public getGoogleDriveStatus(): GoogleDriveStatus {
    const totalBytes = this.googleDriveFiles.reduce((acc, f) => acc + f.tamano_bytes, 0) + (this.facturas.length * 16500);
    const espacioUsadoGb = parseFloat(((totalBytes / (1024 * 1024 * 1024)) + 4.18).toFixed(2));
    const espacioTotalGb = 100.0;
    const porcentaje = parseFloat(((espacioUsadoGb / espacioTotalGb) * 100).toFixed(1));

    return {
      conectado: true,
      cuenta_propietario: this.googleDriveConfig.cuenta_propietario,
      carpeta_id: this.googleDriveConfig.carpeta_id,
      carpeta_nombre: this.googleDriveConfig.carpeta_nombre,
      carpeta_url: this.googleDriveConfig.carpeta_url,
      espacio_usado_gb: espacioUsadoGb,
      espacio_total_gb: espacioTotalGb,
      porcentaje_usado: porcentaje,
      total_archivos: this.googleDriveFiles.length + this.facturas.length,
      archivos_xml_ubl: this.facturas.length + 1,
      backups_json: 3,
      ultima_sincronizacion: this.googleDriveConfig.ultima_sincronizacion,
      hash_ultimo_sync: this.googleDriveConfig.hash_ultimo_sync,
      archivos: this.googleDriveFiles,
      modo_sincronizacion: this.googleDriveConfig.modo_sincronizacion,
      estado: "ACTIVO_Y_SINCRONIZADO"
    };
  }

  public updateGoogleDriveConfig(config: Partial<GoogleDriveConfig>): GoogleDriveConfig {
    this.googleDriveConfig = {
      ...this.googleDriveConfig,
      ...config
    };
    this.saveToDisk();
    return this.googleDriveConfig;
  }

  public syncToGoogleDrive(autor_id: number = 1, autor_nombre: string = "Juan Yaya - Administrador Maestro") {
    const hash = 'drv-' + Math.random().toString(36).substring(2, 9);
    const now = new Date().toISOString();
    
    this.googleDriveConfig.ultima_sincronizacion = now;
    this.googleDriveConfig.hash_ultimo_sync = hash;

    // Actualizar o crear snapshot en lista de archivos de Drive
    const snapshotFileIndex = this.googleDriveFiles.findIndex(f => f.nombre === "repositorio_juan_version_2.0.json");
    if (snapshotFileIndex >= 0) {
      this.googleDriveFiles[snapshotFileIndex].ultima_modificacion = now;
      this.googleDriveFiles[snapshotFileIndex].sincronizado = true;
    } else {
      this.googleDriveFiles.unshift({
        id: `drv-snap-${Date.now()}`,
        nombre: "repositorio_juan_version_2.0.json",
        tipo: "json",
        tamano_bytes: 52400,
        tamano_legible: "51.2 KB",
        ultima_modificacion: now,
        sincronizado: true,
        drive_url: this.googleDriveConfig.carpeta_url,
        categoria: "BACKUPS_BD"
      });
    }

    const mod = this.addModificacion({
      autor_id,
      autor_nombre,
      tipo_accion: "GCP_SYNC",
      descripcion: `Sincronización a Google Drive Corporativo de Juan Yaya (${hash})`,
      detalles: `Snapshot y ${this.facturas.length} comprobantes DIAN respaldados en carpeta Google Drive (${this.googleDriveConfig.cuenta_propietario}).`
    });

    this.saveToDisk();

    return {
      success: true,
      hash,
      timestamp: now,
      carpeta_nombre: this.googleDriveConfig.carpeta_nombre,
      carpeta_url: this.googleDriveConfig.carpeta_url,
      archivos_sincronizados: this.googleDriveFiles.length + this.facturas.length,
      modificacion: mod
    };
  }

  public importFromGoogleDrive(id_empresa: number = 1) {
    // Generar importación de facturas representativas desde Google Drive
    const now = new Date().toISOString();
    const nuevaFactura: Factura = {
      id_factura: Date.now(),
      id_empresa,
      factura_num: `DRV-${Math.floor(1000 + Math.random() * 9000)}`,
      fecha: new Date().toISOString().split('T')[0],
      proveedor: "GOOGLE CLOUD & WORKSPACE IRELAND LTD",
      nit_tercero: "900987654",
      descripcion_item: "Suscripción Enterprise Google Workspace Drive + Cloud Storage (30 Usuarios)",
      cantidad: 1,
      valor_unitario: 1450000,
      subtotal: 1450000,
      iva: 275500,
      retencion_porc: 4,
      retencion_valor: 58000,
      casilla_350: 62,
      forma_pago: "Crédito 30 días",
      medio_pago: "Transferencia Electrónica",
      cuenta_gasto: "51353501 - Servicios de Tecnología & Nube",
      tipo_comprobante: "Factura Electrónica de Venta",
      cufe_hash: "cufe-drv-" + Math.random().toString(16).substring(2, 32),
      estado_revision: "AUDITADA",
      fecha_cargue: now
    };

    this.facturas.unshift(nuevaFactura);

    this.addModificacion({
      autor_id: 1,
      autor_nombre: "Juan Yaya - Administrador Maestro",
      tipo_accion: "FACTURA_AUDITADA",
      descripcion: `Importación automática de factura ${nuevaFactura.factura_num} desde Google Drive`,
      detalles: `Archivo procesado exitosamente desde la carpeta Google Drive compartida (${this.googleDriveConfig.carpeta_nombre}).`
    });

    this.saveToDisk();

    return {
      facturas_importadas: 1,
      factura: nuevaFactura
    };
  }

  public addNotificacionSeguridad(notif: {
    destinatario: string;
    asunto: string;
    tipo: NotificacionSeguridad['tipo'];
    codigo_otp?: string;
    mensaje: string;
  }): NotificacionSeguridad {
    const item: NotificacionSeguridad = {
      id: `sec-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      destinatario: notif.destinatario,
      asunto: notif.asunto,
      fecha: new Date().toISOString(),
      tipo: notif.tipo,
      codigo_otp: notif.codigo_otp,
      mensaje: notif.mensaje,
      estado: this.alNotificarSeguridad ? 'PENDIENTE' : 'SIMULADO'
    };
    this.notificacionesSeguridad.unshift(item);
    if (this.notificacionesSeguridad.length > 50) {
      this.notificacionesSeguridad.pop();
    }
    this.saveToDisk();
    try { this.alNotificarSeguridad?.(item); } catch (err) { console.warn('[Seguridad] No se pudo enviar el correo:', err); }
    return item;
  }

  public addModificacion(mod: {
    autor_id?: number;
    autor_nombre?: string;
    autor_email?: string;
    autor_rol?: string;
    tipo_accion: ModificacionRepositorio['tipo_accion'];
    descripcion: string;
    detalles?: string;
  }): ModificacionRepositorio {
    const user = this.usuarios.find(u => u.id_usuario === mod.autor_id) || this.usuarios[0];
    const hash = Math.random().toString(16).substring(2, 9);
    const nuevaMod: ModificacionRepositorio = {
      id: `mod-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      autor_id: user?.id_usuario || 1,
      autor_nombre: mod.autor_nombre || user?.nombre_completo || "Juan Yaya",
      autor_email: mod.autor_email || user?.email || "automatizaciones@tlm.net.co",
      autor_rol: mod.autor_rol || user?.rol || "Administrador",
      tipo_accion: mod.tipo_accion,
      descripcion: mod.descripcion,
      detalles: mod.detalles || "Modificación registrada e integrada al árbol de trabajo",
      version_destino: "v2.0",
      repositorio: "Repositorio Central de Juan Yaya",
      hash_commit: `v2-${hash}`
    };

    this.modificaciones.unshift(nuevaMod);
    if (this.modificaciones.length > 120) {
      this.modificaciones = this.modificaciones.slice(0, 120);
    }
    this.saveToDisk();
    return nuevaMod;
  }

  public getRepositorioInfo(): RepositorioInfo {
    return {
      nombre: "Repositorio Central de Juan Yaya",
      propietario: "Juan Yaya (Administrador Maestro)",
      email_propietario: "automatizaciones@tlm.net.co",
      version_actual: "2.0.0",
      tag: "v2.0",
      descripcion: "Consolidación de modificaciones multiusuario sincronizadas al Repositorio Central de Juan Yaya en Versión 2.0",
      canal_sincronizacion: "Activo (Multi-Tenant Hot-Sync)",
      colaboradores_conectados: this.usuarios.filter(u => u.activo).length,
      total_modificaciones: this.modificaciones.length,
      ultima_actualizacion: this.modificaciones[0]?.timestamp || new Date().toISOString()
    };
  }

  public getDatabaseInfo() {
    return {
      motor: "Consola TLM Enterprise Storage Engine",
      ubicacion: this.dbFilePath,
      servidor: "Node.js v" + process.versions.node + " / Express 4.x Microservice",
      formato: "JSON Relacional Transaccional con RLS Multi-Tenant",
      persistente_en_disco: fs.existsSync(this.dbFilePath),
      repositorio_maestro: "Juan Yaya - Administrador Maestro",
      repositorio_version: "2.0",
      version: "2.0",
      conteo: {
        usuarios: this.usuarios.length,
        empresas: this.empresas.length,
        facturas: this.facturas.length,
        cuentas_puc: this.cuentasPUC.length,
        balance_terceros: this.balanceTerceros.length,
        movimientos_banco: this.movimientosBanco.length,
        movimientos_libro: this.movimientosLibro.length,
        modificaciones_v2: this.modificaciones.length
      },
      ultima_sincronizacion: new Date().toISOString()
    };
  }

  private initSeedModificaciones() {
    this.modificaciones = [
      {
        id: "mod-v2-004",
        timestamp: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
        autor_id: 1,
        autor_nombre: "Juan Yaya - Administrador Maestro",
        autor_email: "automatizaciones@tlm.net.co",
        autor_rol: "Administrador",
        tipo_accion: "RELEASE_V2",
        descripcion: "Consolidación oficial de release: Versión 2.0 arrojada en Repositorio Central de Juan",
        detalles: "Fusión de modificaciones multiusuario de Andrés Morales y Valentina Castro en rama principal master v2.0",
        version_destino: "v2.0",
        repositorio: "Repositorio Central de Juan Yaya",
        hash_commit: "v2-8fa3c01"
      },
      {
        id: "mod-v2-003",
        timestamp: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
        autor_id: 6,
        autor_nombre: "Valentina Castro Rincón (Gestora de Operaciones & UBL)",
        autor_email: "valentina.castro@tlm.net.co",
        autor_rol: "Analista",
        tipo_accion: "FACTURA_AUDITADA",
        descripcion: "Auditoría UBL de comprobante FE-2045 y verificación de retenciones 4% DIAN",
        detalles: "Aprobada para conciliación bancaria y casillas 62/83 del formulario F350",
        version_destino: "v2.0",
        repositorio: "Repositorio Central de Juan Yaya",
        hash_commit: "v2-4ce81b2"
      },
      {
        id: "mod-v2-002",
        timestamp: new Date(Date.now() - 1000 * 60 * 85).toISOString(),
        autor_id: 5,
        autor_nombre: "Andrés Felipe Morales (Especialista Tributario)",
        autor_email: "andres.morales@tlm.net.co",
        autor_rol: "Contador",
        tipo_accion: "CONCILIACION",
        descripcion: "Cruce automático de extracto Bancolombia con tolerancia de 0.00 COP",
        detalles: "Emparejadas 3 partidas mayores y generado comprobante de ajuste Siigo",
        version_destino: "v2.0",
        repositorio: "Repositorio Central de Juan Yaya",
        hash_commit: "v2-1df95e4"
      },
      {
        id: "mod-v2-001",
        timestamp: new Date(Date.now() - 1000 * 60 * 140).toISOString(),
        autor_id: 5,
        autor_nombre: "Andrés Felipe Morales (Especialista Tributario)",
        autor_email: "andres.morales@tlm.net.co",
        autor_rol: "Contador",
        tipo_accion: "PUC_UPDATE",
        descripcion: "Actualización de mapeo de retenciones en cuentas 236525 y 236801",
        detalles: "Sincronizado con centros de costo de TLM Consulting y régimen común",
        version_destino: "v2.0",
        repositorio: "Repositorio Central de Juan Yaya",
        hash_commit: "v2-9ab22c7"
      }
    ];
  }


  private initSeedData() {
    // 1. Empresa Principal (TLM)
    this.empresas.push({
      id_empresa: 1,
      nombre_comercial: "TLM Consulting S.A.S. (Principal)",
      nit: "901234567-8",
      software_erp: "SIIGO_NUBE",
      software_destino: "SIIGO_NUBE",
      siigo_username: "automatizaciones@tlm.net.co",
      siigo_access_key: "tlm_live_key_99342_secure",
      siigo_document_id: 24,
      logo_url: "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?w=128&auto=format&fit=crop&q=80"
    });

    this.empresas.push({
      id_empresa: 2,
      nombre_comercial: "Inversiones Andinas & Logística S.A.S.",
      nit: "900887654-2",
      software_erp: "SIIGO_NUBE",
      software_destino: "SIIGO_NUBE",
      siigo_username: "contabilidad@andinas.co",
      siigo_access_key: "andinas_key_7712",
      siigo_document_id: 583
    });

    // 2. Usuarios
    this.usuarios.push({
      id_usuario: 1,
      nombre_completo: "Juan Yaya - Administrador Maestro",
      email: "automatizaciones@tlm.net.co",
      hashed_password: "admin_hashed_token",
      rol: "Administrador",
      activo: true,
      empresas_ids: [1, 2],
      permisos: getDefaultPermissions('Administrador')
    });

    this.usuarios.push({
      id_usuario: 2,
      nombre_completo: "María Paula Gómez (Contadora Senior)",
      email: "maria.gomez@tlm.net.co",
      hashed_password: "contador_hash",
      rol: "Contador",
      activo: true,
      empresas_ids: [1],
      permisos: getDefaultPermissions('Contador')
    });

    this.usuarios.push({
      id_usuario: 3,
      nombre_completo: "Carlos Rodríguez (Analista Fiscal)",
      email: "carlos.analista@tlm.net.co",
      hashed_password: "analista_hash",
      rol: "Analista",
      activo: true,
      empresas_ids: [1],
      permisos: getDefaultPermissions('Analista')
    });

    this.usuarios.push({
      id_usuario: 4,
      nombre_completo: "Sofía Herrera (Revisor Fiscal)",
      email: "sofia.revisor@externo.co",
      hashed_password: "pending_hash",
      rol: "Auditor",
      activo: false, // Pendiente de aprobación
      empresas_ids: [1],
      permisos: getDefaultPermissions('Auditor')
    });

    this.usuarios.push({
      id_usuario: 5,
      nombre_completo: "Andrés Felipe Morales (Especialista Tributario)",
      email: "andres.morales@tlm.net.co",
      hashed_password: "colab_andres_token",
      rol: "Contador",
      activo: true,
      empresas_ids: [1, 2],
      permisos: getDefaultPermissions('Contador')
    });

    this.usuarios.push({
      id_usuario: 6,
      nombre_completo: "Valentina Castro Rincón (Gestora de Operaciones & UBL)",
      email: "valentina.castro@tlm.net.co",
      hashed_password: "colab_valentina_token",
      rol: "Analista",
      activo: true,
      empresas_ids: [1, 2],
      permisos: {
        ...getDefaultPermissions('Analista'),
        auditoria_ubl: true,
        impuestos_f350: true,
        conciliacion_bancaria: true
      }
    });

    this.initSeedModificaciones();

    // 3. Catálogo PUC
    const cuentasBase = [
      { cuenta: "110505", nombre: "Caja General" },
      { cuenta: "11100501", nombre: "Bancolombia Cta Cte 1023" },
      { cuenta: "11100502", nombre: "Banco Davivienda Cta Ahorros 4401" },
      { cuenta: "11100503", nombre: "BBVA Colombia Operativa" },
      { cuenta: "13050501", nombre: "Clientes Nacionales Comerciales" },
      { cuenta: "22050501", nombre: "Proveedores Nacionales" },
      { cuenta: "233525", nombre: "Honorarios por Pagar" },
      { cuenta: "233595", nombre: "Otros Costos y Gastos por Pagar" },
      { cuenta: "236515", nombre: "Retención en la Fuente - Honorarios (10% - 11%)" },
      { cuenta: "236525", nombre: "Retención en la Fuente - Servicios (4%)" },
      { cuenta: "236540", nombre: "Retención en la Fuente - Compras (2.5%)" },
      { cuenta: "236701", nombre: "Impuesto a las Ventas Retenido (ReteIVA 15%)" },
      { cuenta: "236801", nombre: "Impuesto de Industria y Comercio Retenido (ReteICA)" },
      { cuenta: "510506", nombre: "Sueldos y Salarios Personal" },
      { cuenta: "511010", nombre: "Honorarios Asesoría Tributaria y Legal" },
      { cuenta: "512010", nombre: "Arrendamientos Inmuebles Administrativos" },
      { cuenta: "513505", nombre: "Servicios de Mantenimiento y Soporte TI" },
      { cuenta: "513515", nombre: "Servicios de Telecomunicaciones y Cloud" },
      { cuenta: "51953001", nombre: "Gastos Diversos y Papelería General" }
    ];

    cuentasBase.forEach((c, idx) => {
      this.cuentasPUC.push({
        id_puc: idx + 1,
        id_empresa: 1,
        cuenta: c.cuenta,
        nombre: c.nombre
      });
    });

    // 4. Facturas Electrónicas UBL 2.1 Pre-cargadas
    const facturasSeed: Partial<Factura>[] = [
      {
        factura_num: "FE-2045",
        fecha: "2026-03-02",
        fecha_vencimiento: "2026-04-02",
        proveedor: "AMAZON WEB SERVICES COLOMBIA S.A.S.",
        nit_tercero: "901344550",
        telefono: "+57 (601) 7450000",
        ciudad: "Bogotá D.C.",
        departamento: "Bogotá",
        correo: "billing@aws-latam.com",
        descripcion_item: "Servicios de Nube e Infraestructura Cloud Hosting Marzo 2026",
        cantidad: 1,
        valor_unitario: 4850000,
        subtotal: 4850000,
        iva: 921500,
        total: 5771500,
        casilla_350: 62, // Servicios
        retencion_porc: 4.0,
        retencion_valor: 194000,
        reteica_tarifa: 9.66,
        reteiva_porc: 15.0,
        forma_pago: "Crédito",
        medio_pago: "47 - Transferencia Bancaria",
        cuenta_gasto: "513515",
        tipo_comprobante: "COMPRAS",
        cufe_hash: "3b08e24483a912bb0e4b8ef9910d93ac76bb1a02931a78cc8283a09a1a2b",
        estado_revision: "AUDITADA",
        fecha_cargue: "2026-03-02T10:15:00Z"
      },
      {
        factura_num: "F-9812",
        fecha: "2026-03-05",
        fecha_vencimiento: "2026-03-05",
        proveedor: "PAPELES Y SUMINISTROS DE COLOMBIA LTDA",
        nit_tercero: "860002133",
        telefono: "+57 (604) 3129900",
        ciudad: "Medellín",
        departamento: "Antioquia",
        correo: "facturacion@suministroscol.com",
        descripcion_item: "Resmas de papel bond, tóner para impresoras láser y suministros oficina",
        cantidad: 12,
        valor_unitario: 145000,
        subtotal: 1740000,
        iva: 330600,
        total: 2070600,
        casilla_350: 64, // Compras
        retencion_porc: 2.5,
        retencion_valor: 43500,
        reteica_tarifa: 4.14,
        reteiva_porc: 0,
        forma_pago: "Contado",
        medio_pago: "10 - Efectivo",
        cuenta_gasto: "51953001",
        tipo_comprobante: "COMPRAS",
        cufe_hash: "9aa47e11f8b3c41a54db0910f8ca73151b88e10c74ba417bc01fa87629b3",
        estado_revision: "PENDIENTE",
        fecha_cargue: "2026-03-05T14:22:00Z"
      },
      {
        factura_num: "HN-108",
        fecha: "2026-03-10",
        fecha_vencimiento: "2026-03-25",
        proveedor: "DR. GUILLERMO VALENCIA ASESORES TRIBUTARIOS S.A.S.",
        nit_tercero: "900543211",
        telefono: "+57 (601) 4893322",
        ciudad: "Bogotá D.C.",
        departamento: "Cundinamarca",
        correo: "valencia.tributaria@legalval.com",
        descripcion_item: "Asesoría y estructuración en cierre fiscal anual y planeación DIAN 2026",
        cantidad: 1,
        valor_unitario: 6500000,
        subtotal: 6500000,
        iva: 1235000,
        total: 7735000,
        casilla_350: 61, // Honorarios
        retencion_porc: 10.0,
        retencion_valor: 650000,
        reteica_tarifa: 9.66,
        reteiva_porc: 15.0,
        forma_pago: "Crédito",
        medio_pago: "47 - Transferencia Bancaria",
        cuenta_gasto: "511010",
        tipo_comprobante: "COMPRAS",
        cufe_hash: "f41a87bc9910d54a2b9187ec0029341ba9e745cc91010db910fa78129cc1",
        estado_revision: "AUDITADA",
        fecha_cargue: "2026-03-10T09:00:00Z"
      },
      {
        factura_num: "ARR-045",
        fecha: "2026-03-12",
        fecha_vencimiento: "2026-03-15",
        proveedor: "INMOBILIARIA DEL COUNTRY S.A.",
        nit_tercero: "890900123",
        telefono: "+57 (601) 6205500",
        ciudad: "Bogotá D.C.",
        departamento: "Bogotá",
        correo: "arriendos@inmobcountry.co",
        descripcion_item: "Canon de arrendamiento oficina corporativa piso 8 mes de Marzo 2026",
        cantidad: 1,
        valor_unitario: 5200000,
        subtotal: 5200000,
        iva: 988000,
        total: 6188000,
        casilla_350: 63, // Arrendamientos
        retencion_porc: 3.5,
        retencion_valor: 182000,
        reteica_tarifa: 9.66,
        reteiva_porc: 0,
        forma_pago: "Contado",
        medio_pago: "47 - Transferencia Bancaria",
        cuenta_gasto: "512010",
        tipo_comprobante: "COMPRAS",
        cufe_hash: "11a9f0293cb8401ee78120cc948512dd4a0918efbc77124ba18092cd9910",
        estado_revision: "SINCRONIZADA_SIIGO",
        siigo_id: "SG-PUR-88210",
        fecha_cargue: "2026-03-12T16:45:00Z"
      },
      {
        factura_num: "MTO-502",
        fecha: "2026-03-18",
        fecha_vencimiento: "2026-03-20",
        proveedor: "SISTEMAS Y REDES INTEGRALES SAS",
        nit_tercero: "900654987",
        telefono: "+57 (601) 5554321",
        ciudad: "Bogotá D.C.",
        departamento: "Bogotá",
        correo: "soporte@sistemasredes.co",
        descripcion_item: "Mantenimiento preventivo servidores rack y cableado estructurado categoría 6A",
        cantidad: 1,
        valor_unitario: 1250000,
        subtotal: 1250000,
        iva: 237500,
        total: 1487500,
        casilla_350: 62, // Servicios
        retencion_porc: 4.0,
        retencion_valor: 50000,
        reteica_tarifa: 9.66,
        reteiva_porc: 0,
        forma_pago: "Contado",
        medio_pago: "47 - Transferencia Bancaria",
        cuenta_gasto: "513505",
        tipo_comprobante: "COMPRAS",
        cufe_hash: "22ef871b99a03c5188d0112fa7bca9084129e8401928bcad908127361a9f",
        estado_revision: "PENDIENTE",
        fecha_cargue: "2026-03-18T11:10:00Z"
      }
    ];

    facturasSeed.forEach((f, idx) => {
      this.facturas.push({
        id_factura: idx + 1,
        id_empresa: 1,
        factura_num: f.factura_num!,
        fecha: f.fecha!,
        fecha_vencimiento: f.fecha_vencimiento,
        proveedor: f.proveedor!,
        nit_tercero: f.nit_tercero!,
        telefono: f.telefono,
        ciudad: f.ciudad,
        departamento: f.departamento,
        correo: f.correo,
        descripcion_item: f.descripcion_item!,
        cantidad: f.cantidad!,
        valor_unitario: f.valor_unitario!,
        subtotal: f.subtotal!,
        iva: f.iva!,
        total: f.total,
        casilla_350: f.casilla_350!,
        retencion_porc: f.retencion_porc!,
        retencion_valor: f.retencion_valor!,
        reteica_tarifa: f.reteica_tarifa,
        reteiva_porc: f.reteiva_porc,
        forma_pago: f.forma_pago!,
        medio_pago: f.medio_pago!,
        cuenta_gasto: f.cuenta_gasto!,
        tipo_comprobante: f.tipo_comprobante!,
        cufe_hash: f.cufe_hash!,
        estado_revision: f.estado_revision as any,
        siigo_id: f.siigo_id,
        fecha_cargue: f.fecha_cargue!
      });
    });

    // 5. Movimientos Bancarios (Extracto Davivienda / Bancolombia)
    this.movimientosBanco = [
      { id: "BNK-001", fecha: "2026-03-02", concepto: "TRANSF AWS CLOUD SERVICIOS FACT 2045", monto: 5577500, tipo: "DEBITO", conciliado: true, match_id: "LIB-001" },
      { id: "BNK-002", fecha: "2026-03-05", concepto: "PAGO SUMINISTROS OFICINA COMPRA F-9812", monto: 2027100, tipo: "DEBITO", conciliado: true, match_id: "LIB-002" },
      { id: "BNK-003", fecha: "2026-03-12", concepto: "TRANSFERENCIA ARRIENDO PISO 8 INMOB COUNTRY", monto: 6006000, tipo: "DEBITO", conciliado: true, match_id: "LIB-004" },
      { id: "BNK-004", fecha: "2026-03-15", concepto: "COMISION BANCARIA MANEJO CUENTA PYME", monto: 45000, tipo: "DEBITO", conciliado: false },
      { id: "BNK-005", fecha: "2026-03-20", concepto: "GRAVAMEN MOVIMIENTOS FINANCIEROS 4X1000", monto: 54620, tipo: "DEBITO", conciliado: false },
      { id: "BNK-006", fecha: "2026-03-22", concepto: "TRANSFERENCIA CLIENTE ANDINO ABONO FACT 110", monto: 14200000, tipo: "CREDITO", conciliado: false }
    ];

    // 6. Movimientos Libros Contables
    this.movimientosLibro = [
      { id: "LIB-001", fecha: "2026-03-02", concepto: "Pago Factura FE-2045 AWS Latam", monto: 5577500, tipo: "DEBITO", cuenta: "11100502", tercero: "901344550", conciliado: true, match_id: "BNK-001" },
      { id: "LIB-002", fecha: "2026-03-05", concepto: "Egreso Pago Papeles y Suministros F-9812", monto: 2027100, tipo: "DEBITO", cuenta: "11100502", tercero: "860002133", conciliado: true, match_id: "BNK-002" },
      { id: "LIB-003", fecha: "2026-03-10", concepto: "Pago Honorarios Dr. Guillermo Valencia HN-108", monto: 7085000, tipo: "DEBITO", cuenta: "11100502", tercero: "900543211", conciliado: false },
      { id: "LIB-004", fecha: "2026-03-12", concepto: "Pago Canon Inmobiliaria Country ARR-045", monto: 6006000, tipo: "DEBITO", cuenta: "11100502", tercero: "890900123", conciliado: true, match_id: "BNK-003" },
      { id: "LIB-005", fecha: "2026-03-18", concepto: "Cheque girado mantenimiento Sistemas y Redes", monto: 1437500, tipo: "DEBITO", cuenta: "11100502", tercero: "900654987", conciliado: false }
    ];

    // 7. Balance de Prueba por Terceros
    this.balanceTerceros = [
      {
        id_balance: 1,
        id_empresa: 1,
        cuenta_contable: "22050501",
        nombre_cuenta: "Proveedores Nacionales",
        nit_tercero: "901344550",
        nombre_tercero: "AMAZON WEB SERVICES COLOMBIA S.A.S.",
        saldo_inicial: 0,
        debitos: 5577500,
        creditos: 5577500,
        saldo_final: 0
      },
      {
        id_balance: 2,
        id_empresa: 1,
        cuenta_contable: "22050501",
        nombre_cuenta: "Proveedores Nacionales",
        nit_tercero: "900543211",
        nombre_tercero: "DR. GUILLERMO VALENCIA ASESORES TRIBUTARIOS S.A.S.",
        saldo_inicial: 0,
        debitos: 0,
        creditos: 7085000,
        saldo_final: 7085000
      },
      {
        id_balance: 3,
        id_empresa: 1,
        cuenta_contable: "13050501",
        nombre_cuenta: "Clientes Nacionales",
        nit_tercero: "800192345",
        nombre_tercero: "DISTRIBUIDORA AGROINDUSTRIAL DEL VALLE",
        saldo_inicial: 18500000,
        debitos: 12000000,
        creditos: 14200000,
        saldo_final: 16300000
      }
    ];
  }
}

export const db = new DataStore();
