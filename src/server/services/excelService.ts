import * as XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import type { DataStore } from '../storage/dataStore.ts';

export class ExcelService {
  /**
   * Genera el libro Excel (.xlsx) completo con todas las colecciones de la base de datos
   * Organizado en hojas individuales con formato contable empresarial
   */
  public static generarLibroCompleto(db: DataStore): { buffer: Buffer; filePathData: string; filePathPublic: string } {
    const wb = XLSX.utils.book_new();

    // 1. HOJA: RESUMEN GENERAL & METADATOS DEL SISTEMA
    const resumenData = [
      { "PARÁMETRO": "Nombre de Base de Datos", "VALOR / DETALLE": "Consola TLM - Enterprise Database v2.0" },
      { "PARÁMETRO": "Fecha de Generación", "VALOR / DETALLE": new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }) },
      { "PARÁMETRO": "Ambiente & Servidor", "VALOR / DETALLE": "Google Cloud Run / Express Node.js ESM" },
      { "PARÁMETRO": "Cuenta Propietario Master", "VALOR / DETALLE": "automatizaciones@tlm.net.co (Juan Yaya)" },
      { "PARÁMETRO": "Empresa Principal", "VALOR / DETALLE": db.empresas[0]?.nombre_comercial || 'TLM Consulting SAS BIC' },
      { "PARÁMETRO": "NIT Principal", "VALOR / DETALLE": db.empresas[0]?.nit || '901.554.892-1' },
      { "PARÁMETRO": "Total Facturas DIAN Registradas", "VALOR / DETALLE": db.facturas.length },
      { "PARÁMETRO": "Total Cuentas PUC", "VALOR / DETALLE": db.cuentasPUC.length },
      { "PARÁMETRO": "Total Terceros en Balance", "VALOR / DETALLE": db.balanceTerceros.length },
      { "PARÁMETRO": "Total Movimientos Bancarios", "VALOR / DETALLE": db.movimientosBanco.length },
      { "PARÁMETRO": "Total Asientos en Libro", "VALOR / DETALLE": db.movimientosLibro.length },
      { "PARÁMETRO": "Total Usuarios Activos", "VALOR / DETALLE": db.usuarios.length },
      { "PARÁMETRO": "Total Desarrolladores de Código", "VALOR / DETALLE": db.desarrolladores.length },
      { "PARÁMETRO": "Total Archivos Google Drive Conectados", "VALOR / DETALLE": db.googleDriveFiles.length },
      { "PARÁMETRO": "Auditorías & Commits Registrados", "VALOR / DETALLE": db.modificaciones.length },
      { 
        "PARÁMETRO": "Valor Total Compras Facturadas (COP)", 
        "VALOR / DETALLE": `$${db.facturas.reduce((acc, f) => acc + (f.total || (f.subtotal + f.iva - f.retencion_valor) || 0), 0).toLocaleString('es-CO')}` 
      },
      { 
        "PARÁMETRO": "Saldo Total Bancos (COP)", 
        "VALOR / DETALLE": `$${db.movimientosBanco.reduce((acc, m) => acc + (m.saldo || 0), 0).toLocaleString('es-CO')}` 
      }
    ];
    const wsResumen = XLSX.utils.json_to_sheet(resumenData);
    wsResumen['!cols'] = [{ wch: 35 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, wsResumen, 'RESUMEN_GENERAL');

    // 2. HOJA: FACTURAS DIAN
    const facturasRows = db.facturas.map(f => ({
      "ID": f.id_factura,
      "NÚMERO FACTURA": f.factura_num,
      "TIPO COMPROBANTE": f.tipo_comprobante,
      "FECHA": f.fecha,
      "FECHA VENCIMIENTO": f.fecha_vencimiento || '',
      "NIT PROVEEDOR": f.nit_tercero,
      "RAZÓN SOCIAL PROVEEDOR": f.proveedor,
      "DESCRIPCIÓN ITEM": f.descripcion_item,
      "CANTIDAD": f.cantidad,
      "VALOR UNITARIO COP": f.valor_unitario,
      "SUBTOTAL COP": f.subtotal,
      "IVA COP": f.iva,
      "RETENCIÓN VALOR COP": f.retencion_valor,
      "PORCENTAJE RETENCIÓN": `${f.retencion_porc}%`,
      "CASILLA F350": f.casilla_350,
      "TOTAL FACTURA COP": f.total || (f.subtotal + f.iva - f.retencion_valor),
      "FORMA PAGO": f.forma_pago,
      "MEDIO PAGO": f.medio_pago,
      "CUENTA GASTO PUC": f.cuenta_gasto,
      "ESTADO AUDITORÍA": f.estado_revision,
      "CUFE HASH DIAN": f.cufe_hash || 'N/A'
    }));
    const wsFacturas = XLSX.utils.json_to_sheet(facturasRows);
    wsFacturas['!cols'] = [
      { wch: 8 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 16 },
      { wch: 16 }, { wch: 32 }, { wch: 30 }, { wch: 10 }, { wch: 16 },
      { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 14 },
      { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 45 }
    ];
    XLSX.utils.book_append_sheet(wb, wsFacturas, 'FACTURAS_DIAN');

    // 3. HOJA: PLAN DE CUENTAS PUC
    const pucRows = db.cuentasPUC.map(c => ({
      "ID PUC": c.id_puc,
      "EMPRESA ID": c.id_empresa,
      "CÓDIGO CUENTA": c.cuenta,
      "NOMBRE CUENTA": c.nombre,
      "NATURALEZA": c.naturaleza || 'DEBITO'
    }));
    const wsPuc = XLSX.utils.json_to_sheet(pucRows);
    wsPuc['!cols'] = [
      { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 45 }, { wch: 14 }
    ];
    XLSX.utils.book_append_sheet(wb, wsPuc, 'PLAN_CUENTAS_PUC');

    // 4. HOJA: BALANCE TERCEROS
    const tercerosRows = db.balanceTerceros.map(t => ({
      "ID BALANCE": t.id_balance,
      "EMPRESA ID": t.id_empresa,
      "CUENTA CONTABLE": t.cuenta_contable,
      "NOMBRE CUENTA": t.nombre_cuenta,
      "NIT / CÉDULA": t.nit_tercero,
      "NOMBRE TERCERO": t.nombre_tercero,
      "SALDO INICIAL COP": t.saldo_inicial,
      "DÉBITOS MES COP": t.debitos,
      "CRÉDITOS MES COP": t.creditos,
      "SALDO FINAL COP": t.saldo_final
    }));
    const wsTerceros = XLSX.utils.json_to_sheet(tercerosRows);
    wsTerceros['!cols'] = [
      { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 32 }, { wch: 16 },
      { wch: 35 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }
    ];
    XLSX.utils.book_append_sheet(wb, wsTerceros, 'BALANCE_TERCEROS');

    // 5. HOJA: MOVIMIENTOS BANCARIOS
    const bancosRows = db.movimientosBanco.map(m => ({
      "ID MOVIMIENTO": m.id,
      "FECHA": m.fecha,
      "REFERENCIA": m.referencia || '',
      "CONCEPTO": m.concepto,
      "TIPO": m.tipo,
      "MONTO COP": m.monto,
      "SALDO COP": m.saldo || 0,
      "CONCILIADO": m.conciliado ? 'SÍ' : 'NO',
      "MATCH ID": m.match_id || 'N/A'
    }));
    const wsBancos = XLSX.utils.json_to_sheet(bancosRows);
    wsBancos['!cols'] = [
      { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 40 },
      { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }
    ];
    XLSX.utils.book_append_sheet(wb, wsBancos, 'MOVIMIENTOS_BANCO');

    // 6. HOJA: MOVIMIENTOS LIBRO MAYOR
    const libroRows = db.movimientosLibro.map(l => ({
      "ID ASIENTO": l.id,
      "FECHA": l.fecha,
      "CONCEPTO": l.concepto,
      "CÓDIGO CUENTA": l.cuenta,
      "TERCERO": l.tercero || '',
      "TIPO": l.tipo,
      "MONTO COP": l.monto,
      "CONCILIADO": l.conciliado ? 'SÍ' : 'NO',
      "MATCH ID": l.match_id || 'N/A'
    }));
    const wsLibro = XLSX.utils.json_to_sheet(libroRows);
    wsLibro['!cols'] = [
      { wch: 14 }, { wch: 14 }, { wch: 35 }, { wch: 16 },
      { wch: 25 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 16 }
    ];
    XLSX.utils.book_append_sheet(wb, wsLibro, 'MOVIMIENTOS_LIBRO');

    // 7. HOJA: USUARIOS Y PERMISOS
    const usuariosRows = db.usuarios.map(u => ({
      "ID USUARIO": u.id_usuario,
      "NOMBRE COMPLETO": u.nombre_completo,
      "EMAIL": u.email,
      "ROL": u.rol,
      "ESTADO": u.activo ? 'ACTIVO' : 'INACTIVO',
      "EMPRESAS ASIGNADAS (IDS)": (u.empresas_ids || []).join(', '),
    ""ADMINISTRADOR": u.permisos?.administrador ? 'SÍ' : 'NO',
      "AUDITORIA UBL": u.permisos?.auditoria_ubl ? 'SÍ' : 'NO',
      "IMPUESTOS F350": u.permisos?.impuestos_f350 ? 'SÍ' : 'NO',
      "CONCILIACION BANCARIA": u.permisos?.conciliacion_bancaria ? 'SÍ' : 'NO',
      "TRANSMITIR SIIGO": u.permisos?.transmitir_siigo ? 'SÍ' : 'NO',
      "GESTION USUARIOS": u.permisos?.gestion_usuarios ? 'SÍ' : 'NO',
      "BASE DE DATOS": u.permisos?.base_datos ? 'SÍ' : 'NO',
      "ARQUITECTURA ESCALA": u.permisos?.arquitectura_escala ? 'SÍ' : 'NO'
    const wsUsuarios = XLSX.utils.json_to_sheet(usuariosRows);
    wsUsuarios['!cols'] = [
      { wch: 12 }, { wch: 28 }, { wch: 30 }, { wch: 16 }, { wch: 12 },
      { wch: 25 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 20 },
      { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }
    ];
    XLSX.utils.book_append_sheet(wb, wsUsuarios, 'USUARIOS_Y_PERMISOS');

    // 8. HOJA: ACCESOS DESARROLLADORES Y CODIGO
    const devsRows = db.desarrolladores.map(d => ({
      "ID DEV": d.id,
      "EMAIL": d.email,
      "NOMBRE": d.nombre,
      "ROL TÉCNICO": d.rol_tecnico,
      "ESTADO": d.estado,
      "TOKEN ACCESO": d.token_desarrollador,
      "EDITAR CÓDIGO": d.permisos_codigo.editar_codigo ? 'SÍ' : 'NO',
     "EDITAR CÓDIGO": d.permisos_codigo?.editar_codigo ? 'SÍ' : 'NO',
      "COMMITS GIT": d.permisos_codigo?.hacer_commits_git ? 'SÍ' : 'NO',
      "CLOUD RUN DEPLOY": d.permisos_codigo?.desplegar_cloud_run ? 'SÍ' : 'NO',
      "DRIVE SYNC": d.permisos_codigo?.acceso_google_drive ? 'SÍ' : 'NO',
      "APIS DIAN": d.permisos_codigo?.gestionar_apis_dian ? 'SÍ' : 'NO',
    }));
    const wsDevs = XLSX.utils.json_to_sheet(devsRows);
    wsDevs['!cols'] = [
      { wch: 12 }, { wch: 30 }, { wch: 28 }, { wch: 22 }, { wch: 12 },
      { wch: 26 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 14 },
      { wch: 14 }, { wch: 22 }, { wch: 26 }
    ];
    XLSX.utils.book_append_sheet(wb, wsDevs, 'ACCESOS_DESARROLLADORES');

    // 9. HOJA: ARCHIVOS GOOGLE DRIVE
    const driveRows = db.googleDriveFiles.map(f => ({
      "ID ARCHIVO": f.id,
      "NOMBRE ARCHIVO": f.nombre,
      "TIPO": f.tipo,
      "CATEGORÍA": f.categoria,
      "TAMAÑO BYTES": f.tamano_bytes,
      "TAMAÑO LEGIBLE": f.tamano_legible,
      "ESTADO SINCRONIZACIÓN": f.sincronizado ? 'SINCRONIZADO' : 'PENDIENTE',
      "ENLACE DRIVE": f.drive_url,
      "ÚLTIMA MODIFICACIÓN": f.ultima_modificacion
    }));
    const wsDrive = XLSX.utils.json_to_sheet(driveRows);
    wsDrive['!cols'] = [
      { wch: 14 }, { wch: 45 }, { wch: 10 }, { wch: 18 },
      { wch: 14 }, { wch: 16 }, { wch: 22 }, { wch: 55 }, { wch: 24 }
    ];
    XLSX.utils.book_append_sheet(wb, wsDrive, 'GOOGLE_DRIVE_ARCHIVOS');

    // 10. HOJA: AUDITORIA Y MODIFICACIONES REPOSITORIO V2.0
    const auditRows = db.modificaciones.map(m => ({
      "ID MODIFICACIÓN": m.id,
      "FECHA HORA": m.timestamp,
      "AUTOR": m.autor_nombre,
      "EMAIL AUTOR": m.autor_email,
      "ROL": m.autor_rol,
      "TIPO ACCIÓN": m.tipo_accion,
      "DESCRIPCIÓN": m.descripcion,
      "HASH COMMIT": m.hash_commit,
      "VERSIÓN DESTINO": m.version_destino,
      "REPOSITORIO": m.repositorio,
      "DETALLES": m.detalles || ''
    }));
    const wsAudit = XLSX.utils.json_to_sheet(auditRows);
    wsAudit['!cols'] = [
      { wch: 14 }, { wch: 24 }, { wch: 28 }, { wch: 28 }, { wch: 16 },
      { wch: 20 }, { wch: 45 }, { wch: 16 }, { wch: 16 }, { wch: 30 }, { wch: 50 }
    ];
    XLSX.utils.book_append_sheet(wb, wsAudit, 'AUDITORIA_MODIFICACIONES');

    // Generar buffer XLSX
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Guardar en data/ y en public/ para descarga estática e integración
    const dataDir = path.resolve(process.cwd(), 'data');
    const publicDir = path.resolve(process.cwd(), 'public');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    const fileName = 'tlm_base_de_datos_maestra.xlsx';
    const filePathData = path.join(dataDir, fileName);
    const filePathPublic = path.join(publicDir, fileName);

    fs.writeFileSync(filePathData, buffer);
    fs.writeFileSync(filePathPublic, buffer);

    return { buffer, filePathData, filePathPublic };
  }

  /**
   * Genera un archivo Excel individual para una tabla específica
   */
  public static generarLibroTabla(db: DataStore, tabla: string): { buffer: Buffer; fileName: string } {
    const wb = XLSX.utils.book_new();
    let data: any[] = [];
    let sheetName = 'DATOS';

    switch (tabla.toLowerCase()) {
      case 'facturas':
        sheetName = 'FACTURAS_DIAN';
        data = db.facturas;
        break;
      case 'puc':
      case 'cuentas':
        sheetName = 'PLAN_CUENTAS_PUC';
        data = db.cuentasPUC;
        break;
      case 'terceros':
      case 'balance':
        sheetName = 'BALANCE_TERCEROS';
        data = db.balanceTerceros;
        break;
      case 'bancos':
        sheetName = 'MOVIMIENTOS_BANCO';
        data = db.movimientosBanco;
        break;
      case 'libro':
        sheetName = 'MOVIMIENTOS_LIBRO';
        data = db.movimientosLibro;
        break;
      case 'usuarios':
        sheetName = 'USUARIOS_SISTEMA';
        data = db.usuarios;
        break;
      case 'desarrolladores':
        sheetName = 'ACCESOS_DESARROLLADORES';
        data = db.desarrolladores;
        break;
      default:
        sheetName = 'FACTURAS';
        data = db.facturas;
        break;
    }

    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileName = `tlm_${sheetName.toLowerCase()}.xlsx`;

    return { buffer, fileName };
  }
}
