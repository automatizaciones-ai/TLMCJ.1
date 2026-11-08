/**
 * Notificaciones por correo de la Consola TLM: configuración por empresa, plantillas y eventos.
 * Los secretos del proveedor van en variables de entorno (ver correoService.ts); aquí solo hay destinatarios y preferencias.
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../../db/index.ts';
import { db } from '../storage/dataStore.ts';
import { CorreoService, correoValido, type AdjuntoCorreo, type ResultadoEnvio } from './correoService.ts';
import type { Empresa, Usuario } from '../domain/types.ts';

export type EventoEmpresa = 'CONCILIACION' | 'SIIGO' | 'CARGUE_FACTURAS';

export interface ConfigNotificaciones {
  id_empresa: number;
  activo: boolean;
  destinatarios: string[];
  /** También avisar a los usuarios activos asignados a la empresa */
  incluir_usuarios_empresa: boolean;
  /** Copia a quien ejecuta la acción */
  copia_a_quien_ejecuta: boolean;
  eventos: {
    CONCILIACION: { activo: boolean; solo_con_novedades: boolean; adjuntar_excel: boolean };
    SIIGO: { activo: boolean; solo_con_errores: boolean; adjuntar_informe: boolean };
    CARGUE_FACTURAS: { activo: boolean };
  };
  actualizado_por?: string;
  actualizado_en?: string;
}

/** Configuración global (id_empresa = 0) para los correos de seguridad de las cuentas */
export interface ConfigSeguridad {
  activo: boolean;
  avisar_admins_registro: boolean;
}

export const EVENTOS_EMPRESA: { clave: EventoEmpresa; nombre: string; descripcion: string }[] = [
  { clave: 'CONCILIACION', nombre: 'Conciliación bancaria', descripcion: 'Resultado del cruce: conciliadas, pendientes en libros y en banco, diferencia de saldos y reporte Excel.' },
  { clave: 'SIIGO', nombre: 'Transmisión a Siigo', descripcion: 'Facturas enviadas a Siigo Nube: exitosas, rechazadas con su motivo e informe Excel.' },
  { clave: 'CARGUE_FACTURAS', nombre: 'Cargue de facturas', descripcion: 'Resumen de cada cargue de XML/ZIP: facturas nuevas, duplicadas y PDF guardados.' }
];

const configDefecto = (idEmpresa: number): ConfigNotificaciones => ({
  id_empresa: idEmpresa,
  activo: false,
  destinatarios: [],
  incluir_usuarios_empresa: false,
  copia_a_quien_ejecuta: true,
  eventos: {
    CONCILIACION: { activo: true, solo_con_novedades: false, adjuntar_excel: true },
    SIIGO: { activo: true, solo_con_errores: false, adjuntar_informe: true },
    CARGUE_FACTURAS: { activo: false }
  }
});

const SEGURIDAD_DEFECTO: ConfigSeguridad = { activo: true, avisar_admins_registro: true };

const ARCHIVO = path.resolve(process.cwd(), 'data', 'notificaciones_config.json');
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class NotificacionesServiceClass {
  private cache = new Map<number, any>();
  private cargado: Promise<void> | null = null;

  private cargar(): Promise<void> {
    if (!this.cargado) {
      this.cargado = (async () => {
        try {
          const dump = JSON.parse(fs.readFileSync(ARCHIVO, 'utf-8'));
          Object.entries(dump).forEach(([k, v]) => this.cache.set(Number(k), v));
        } catch {}
        try {
          await pool.query(`CREATE TABLE IF NOT EXISTS notificaciones_config (
              id_empresa INTEGER PRIMARY KEY,
              config JSONB NOT NULL,
              actualizado_en TIMESTAMP DEFAULT now()
            )`);
          const r = await pool.query('SELECT id_empresa, config FROM notificaciones_config');
          r.rows.forEach((x: any) => this.cache.set(Number(x.id_empresa), x.config));
        } catch (err: any) {
          console.warn('[Notificaciones] PostgreSQL no disponible; se usa la copia local:', err.message);
        }
      })();
    }
    return this.cargado;
  }

  private async guardar(id: number, config: any) {
    this.cache.set(id, config);
    try {
      fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
      fs.writeFileSync(ARCHIVO, JSON.stringify(Object.fromEntries(this.cache), null, 2));
    } catch {}
    await pool.query(
      `INSERT INTO notificaciones_config (id_empresa, config, actualizado_en) VALUES ($1, $2, now())
       ON CONFLICT (id_empresa) DO UPDATE SET config = EXCLUDED.config, actualizado_en = now()`,
      [id, JSON.stringify(config)]
    ).catch(err => console.warn('[Notificaciones] No se pudo guardar en PostgreSQL:', err.message));
  }

  async config(idEmpresa: number): Promise<ConfigNotificaciones> {
    await this.cargar();
    const base = configDefecto(idEmpresa);
    const g = this.cache.get(idEmpresa) || {};
    return {
      ...base,
      ...g,
      id_empresa: idEmpresa,
      destinatarios: Array.isArray(g.destinatarios) ? g.destinatarios : [],
      eventos: {
        CONCILIACION: { ...base.eventos.CONCILIACION, ...(g.eventos?.CONCILIACION || {}) },
        SIIGO: { ...base.eventos.SIIGO, ...(g.eventos?.SIIGO || {}) },
        CARGUE_FACTURAS: { ...base.eventos.CARGUE_FACTURAS, ...(g.eventos?.CARGUE_FACTURAS || {}) }
      }
    };
  }

  async guardarConfig(idEmpresa: number, entrada: Partial<ConfigNotificaciones>, autor?: string): Promise<ConfigNotificaciones> {
    const actual = await this.config(idEmpresa);
    const destinatarios = Array.isArray(entrada.destinatarios)
      ? [...new Set(entrada.destinatarios.map(c => String(c).trim().toLowerCase()).filter(Boolean))]
      : actual.destinatarios;
    const invalidos = destinatarios.filter(c => !correoValido(c));
    if (invalidos.length) throw new Error(`Correos no válidos: ${invalidos.join(', ')}`);
    const nueva: ConfigNotificaciones = {
      ...actual,
      activo: entrada.activo ?? actual.activo,
      destinatarios,
      incluir_usuarios_empresa: entrada.incluir_usuarios_empresa ?? actual.incluir_usuarios_empresa,
      copia_a_quien_ejecuta: entrada.copia_a_quien_ejecuta ?? actual.copia_a_quien_ejecuta,
      eventos: {
        CONCILIACION: { ...actual.eventos.CONCILIACION, ...(entrada.eventos?.CONCILIACION || {}) },
        SIIGO: { ...actual.eventos.SIIGO, ...(entrada.eventos?.SIIGO || {}) },
        CARGUE_FACTURAS: { ...actual.eventos.CARGUE_FACTURAS, ...(entrada.eventos?.CARGUE_FACTURAS || {}) }
      },
      actualizado_por: autor,
      actualizado_en: new Date().toISOString()
    };
    await this.guardar(idEmpresa, nueva);
    return nueva;
  }

  async seguridad(): Promise<ConfigSeguridad> {
    await this.cargar();
    return { ...SEGURIDAD_DEFECTO, ...(this.cache.get(0) || {}) };
  }

  async guardarSeguridad(entrada: Partial<ConfigSeguridad>): Promise<ConfigSeguridad> {
    const nueva = { ...(await this.seguridad()), ...entrada };
    await this.guardar(0, nueva);
    return nueva;
  }

  // ---------------- Destinatarios ----------------
  private async destinatarios(empresa: Empresa, cfg: ConfigNotificaciones, ejecutor?: Usuario | null): Promise<{ para: string[]; cc: string[] }> {
    const para = [...cfg.destinatarios];
    if (cfg.incluir_usuarios_empresa) {
      db.usuarios
        .filter(u => u.activo && Array.isArray(u.empresas_ids) && u.empresas_ids.includes(empresa.id_empresa))
        .forEach(u => para.push(u.email));
    }
    const cc: string[] = [];
    if (cfg.copia_a_quien_ejecuta && ejecutor?.email) {
      if (para.length === 0) para.push(ejecutor.email);
      else cc.push(ejecutor.email);
    }
    return { para: [...new Set(para.map(c => c.toLowerCase()))], cc };
  }

  /** Envía un evento de empresa si está activo. Devuelve null cuando no aplica (desactivado o filtrado). */
  async notificarEmpresa(
    evento: EventoEmpresa,
    empresa: Empresa,
    contenido: { asunto: string; html: string; adjuntos?: AdjuntoCorreo[]; hayNovedades?: boolean },
    ejecutor?: Usuario | null
  ): Promise<ResultadoEnvio | null> {
    const cfg = await this.config(empresa.id_empresa);
    const ev: any = cfg.eventos[evento];
    if (!cfg.activo || !ev?.activo) return null;
    if (evento === 'CONCILIACION' && ev.solo_con_novedades && contenido.hayNovedades === false) return null;
    if (evento === 'SIIGO' && ev.solo_con_errores && contenido.hayNovedades === false) return null;
    const { para, cc } = await this.destinatarios(empresa, cfg, ejecutor);
    if (!para.length) return null;
    const adjuntos = (evento === 'CONCILIACION' && !ev.adjuntar_excel) || (evento === 'SIIGO' && !ev.adjuntar_informe) ? [] : contenido.adjuntos;
    return CorreoService.enviar({ para, cc, asunto: contenido.asunto, html: contenido.html, adjuntos, evento, id_empresa: empresa.id_empresa });
  }

  /** Igual que notificarEmpresa, sin bloquear la respuesta */
  notificarEmpresaEnSegundoPlano(...args: Parameters<NotificacionesServiceClass['notificarEmpresa']>) {
    this.notificarEmpresa(...args).catch(err => console.warn('[Notificaciones] Error:', err?.message || err));
  }

  // ---------------- Eventos ----------------
  async conciliacion(empresa: Empresa, r: any, reporteExcel: Buffer | null, ejecutor?: Usuario | null) {
    const pendientes = r.faltan_en_libros.length + r.faltan_en_banco.length;
    const perfecta = pendientes === 0 && Math.abs(r.diferencia_saldos) < 1;
    const estado = perfecta ? '✓ Conciliación perfecta' : r.cuadrado ? 'Cuadrado con pendientes' : 'Descuadrado';
    const color = perfecta ? '#059669' : r.cuadrado ? '#d97706' : '#dc2626';
    const lista = (items: any[], campoDesc: (m: any) => string) => items.slice(0, 15).map(m => [m.fecha, campoDesc(m), cop(m.valor)]);
    const html = plantilla({
      titulo: 'Resultado de conciliación bancaria',
      empresa,
      intro: `Se ejecutó el cruce bancario${r.banco ? ` de <b>${esc(r.banco)}</b>` : ''}${ejecutor ? ` por ${esc(ejecutor.nombre_completo)}` : ''}.`,
      etiqueta: { texto: estado, color },
      datos: [
        ['Auxiliar (libros)', `${esc(r.archivo_auxiliar || '—')} · saldo final ${cop(r.libros.saldo_final)}`],
        ['Extracto (banco)', `${esc(r.archivo_extracto || '—')} · saldo final ${cop(r.extracto.saldo_final)}`],
        ['Diferencia de saldos', `<b style="color:${color}">${cop(r.diferencia_saldos)}</b>`],
        ['Partidas conciliadas', `${r.conciliadas.length} · ${cop(r.totales.conciliado)}`],
        ['Faltan en libros', `${r.faltan_en_libros.length} · ${cop(r.totales.pendiente_libros)}`],
        ['Faltan en banco', `${r.faltan_en_banco.length} · ${cop(r.totales.pendiente_banco)}`]
      ],
      tablas: [
        ...(r.faltan_en_libros.length ? [{ titulo: 'Faltan en libros (pendientes de contabilizar)', columnas: ['Fecha', 'Descripción', 'Valor'], filas: lista(r.faltan_en_libros, m => m.descripcion), mas: r.faltan_en_libros.length - 15 }] : []),
        ...(r.faltan_en_banco.length ? [{ titulo: 'Faltan en banco (pendientes de cobro/pago)', columnas: ['Fecha', 'Comprobante / tercero', 'Valor'], filas: lista(r.faltan_en_banco, m => `${m.comprobante || ''} ${m.tercero || m.descripcion || ''}`.trim()), mas: r.faltan_en_banco.length - 15 }] : [])
      ],
      nota: reporteExcel ? 'Se adjunta el reporte de conciliación en Excel.' : undefined
    });
    return this.notificarEmpresa('CONCILIACION', empresa, {
      asunto: `[${empresa.nombre_comercial}] Conciliación bancaria: ${estado}${pendientes ? ` (${pendientes} pendientes)` : ''}`,
      html,
      hayNovedades: !perfecta,
      adjuntos: reporteExcel ? [{ nombre: `Conciliacion_${empresa.nit}_${hoy()}.xlsx`, contenido: reporteExcel, mime: MIME_XLSX }] : []
    }, ejecutor);
  }

  async siigo(empresa: Empresa, r: { exitosas: number; fallidas: number; omitidas: number; reporte_detalle: any[] }, informe: Buffer | null, ejecutor?: Usuario | null) {
    const errores = r.reporte_detalle.filter(d => d.status !== 'success');
    const html = plantilla({
      titulo: 'Transmisión de facturas a Siigo Nube',
      empresa,
      intro: `Resultado del envío de facturas de compra a Siigo${ejecutor ? ` realizado por ${esc(ejecutor.nombre_completo)}` : ''}.`,
      etiqueta: { texto: r.fallidas ? `${r.fallidas} rechazada(s)` : 'Todas aceptadas', color: r.fallidas ? '#dc2626' : '#059669' },
      datos: [['Exitosas', String(r.exitosas)], ['Rechazadas', String(r.fallidas)], ['Omitidas (ventas o ya enviadas)', String(r.omitidas)]],
      tablas: errores.length ? [{ titulo: 'Novedades', columnas: ['Factura', 'Proveedor', 'Detalle'], filas: errores.slice(0, 20).map(e => [e.factura_num, e.proveedor, e.mensaje]), mas: errores.length - 20 }] : [],
      nota: informe ? 'Se adjunta el informe de transmisión en Excel.' : undefined
    });
    return this.notificarEmpresa('SIIGO', empresa, {
      asunto: `[${empresa.nombre_comercial}] Siigo: ${r.exitosas} exitosas, ${r.fallidas} rechazadas`,
      html,
      hayNovedades: r.fallidas > 0,
      adjuntos: informe ? [{ nombre: `Informe_Siigo_${empresa.nit}_${hoy()}.xlsx`, contenido: informe, mime: MIME_XLSX }] : []
    }, ejecutor);
  }

  async cargueFacturas(empresa: Empresa, r: { archivos: number; nuevas: number; duplicadas: number; ventas: number; compras: number; pdfs: number }, ejecutor?: Usuario | null) {
    const html = plantilla({
      titulo: 'Cargue de facturas electrónicas',
      empresa,
      intro: `Se procesaron ${r.archivos} archivo(s)${ejecutor ? ` cargados por ${esc(ejecutor.nombre_completo)}` : ''}.`,
      datos: [['Facturas nuevas', String(r.nuevas)], ['Duplicadas omitidas', String(r.duplicadas)], ['Ventas / compras', `${r.ventas} / ${r.compras}`], ['PDF originales guardados', String(r.pdfs)]]
    });
    return this.notificarEmpresa('CARGUE_FACTURAS', empresa, { asunto: `[${empresa.nombre_comercial}] Cargue de facturas: ${r.nuevas} nuevas`, html }, ejecutor);
  }

  /** Correo de prueba para validar la configuración */
  async prueba(para: string[], empresa?: Empresa | null) {
    const est = CorreoService.estado();
    return CorreoService.enviar({
      para,
      asunto: 'Prueba de notificaciones - Consola TLM',
      html: plantilla({
        titulo: 'Correo de prueba',
        empresa: empresa || undefined,
        intro: 'Si recibe este mensaje, las notificaciones por correo de la Consola TLM están funcionando.',
        datos: [['Proveedor', est.proveedor], ['Remitente', est.remitente || '—'], ['Enviado', new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })]]
      }),
      evento: 'PRUEBA',
      id_empresa: empresa?.id_empresa
    });
  }

  /** Mensajes de seguridad de cuentas (contraseñas, códigos, accesos) */
  async seguridadCuenta(destinatario: string, asunto: string, mensaje: string): Promise<ResultadoEnvio | null> {
    const cfg = await this.seguridad();
    if (!cfg.activo) return null;
    return CorreoService.enviar({
      para: [destinatario],
      asunto,
      html: plantilla({ titulo: asunto.replace(/\s*-\s*(Consola )?TLM.*$/i, ''), intro: esc(mensaje).replace(/\[(\d{6})\]/g, '<b style="font-size:22px;letter-spacing:4px;color:#271a82">$1</b>'), nota: 'Este es un mensaje automático de seguridad de la Consola TLM. No lo reenvíe.' }),
      evento: 'SEGURIDAD'
    });
  }

  async avisarAdminsRegistro(nuevo: { nombre_completo: string; email: string }) {
    const cfg = await this.seguridad();
    if (!cfg.activo || !cfg.avisar_admins_registro) return null;
    const admins = db.usuarios.filter(u => u.activo && (u.rol === 'Administrador' || u.permisos?.administrador)).map(u => u.email);
    if (!admins.length) return null;
    return CorreoService.enviar({
      para: admins,
      asunto: `Nueva solicitud de acceso: ${nuevo.nombre_completo}`,
      html: plantilla({
        titulo: 'Solicitud de acceso pendiente',
        intro: `<b>${esc(nuevo.nombre_completo)}</b> (${esc(nuevo.email)}) se registró en la Consola TLM y espera aprobación.`,
        nota: 'Apruebe o rechace la solicitud en Admin Usuarios & Cloud.'
      }),
      evento: 'SEGURIDAD'
    });
  }
}

// ---------------- Plantilla HTML (estilos en línea para clientes de correo) ----------------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const cop = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 }).format(n || 0);
const hoy = () => new Date().toISOString().substring(0, 10);

export function plantilla(p: {
  titulo: string;
  empresa?: Pick<Empresa, 'nombre_comercial' | 'nit'>;
  intro: string;
  etiqueta?: { texto: string; color: string };
  datos?: [string, string][];
  tablas?: { titulo: string; columnas: string[]; filas: string[][]; mas?: number }[];
  nota?: string;
}): string {
  const url = (process.env.APP_URL || '').trim();
  const datos = (p.datos || []).map(([k, v]) =>
    `<tr><td style="padding:6px 10px;color:#64748b;font-size:13px;border-bottom:1px solid #eef0f4">${esc(k)}</td><td style="padding:6px 10px;font-size:13px;color:#1f2937;border-bottom:1px solid #eef0f4;text-align:right">${v}</td></tr>`).join('');
  const tablas = (p.tablas || []).map(t => `
    <h3 style="font-size:14px;color:#271a82;margin:22px 0 8px">${esc(t.titulo)}</h3>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px">
      <tr>${t.columnas.map((c, i) => `<th style="text-align:${i === t.columnas.length - 1 ? 'right' : 'left'};padding:6px 8px;background:#f4f5fb;color:#475569">${esc(c)}</th>`).join('')}</tr>
      ${t.filas.map(f => `<tr>${f.map((c, i) => `<td style="padding:5px 8px;border-bottom:1px solid #eef0f4;${i === f.length - 1 ? 'text-align:right;white-space:nowrap' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}
    </table>
    ${t.mas && t.mas > 0 ? `<p style="font-size:12px;color:#64748b;margin:6px 0 0">… y ${t.mas} más en el reporte adjunto.</p>` : ''}`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f4f5fb;font-family:Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5fb;padding:24px 0"><tr><td align="center">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
      <tr><td style="background:#271a82;padding:18px 24px;color:#ffffff">
        <div style="font-size:12px;letter-spacing:1px;color:#fa9d1c;font-weight:bold">CONSOLA TLM</div>
        <div style="font-size:19px;font-weight:bold;margin-top:4px">${esc(p.titulo)}</div>
        ${p.empresa ? `<div style="font-size:12px;color:#c7c3ee;margin-top:4px">${esc(p.empresa.nombre_comercial)} · NIT ${esc(p.empresa.nit)}</div>` : ''}
      </td></tr>
      <tr><td style="padding:22px 24px;color:#1f2937;font-size:14px;line-height:1.5">
        ${p.etiqueta ? `<div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${p.etiqueta.color};color:#fff;font-size:12px;font-weight:bold;margin-bottom:12px">${esc(p.etiqueta.texto)}</div>` : ''}
        <p style="margin:0 0 14px">${p.intro}</p>
        ${datos ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${datos}</table>` : ''}
        ${tablas}
        ${p.nota ? `<p style="margin:18px 0 0;font-size:12px;color:#64748b">${esc(p.nota)}</p>` : ''}
        ${url ? `<p style="margin:20px 0 0"><a href="${esc(url)}" style="display:inline-block;background:#271a82;color:#fff;text-decoration:none;padding:9px 16px;border-radius:10px;font-size:13px;font-weight:bold">Abrir la Consola TLM</a></p>` : ''}
      </td></tr>
      <tr><td style="padding:12px 24px;background:#fafafa;color:#94a3b8;font-size:11px">Mensaje automático de la Consola TLM. Para dejar de recibirlo, un administrador puede ajustar las notificaciones de la empresa.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

export const NotificacionesService = new NotificacionesServiceClass();

// Cada aviso de seguridad que registra el sistema (contraseñas, códigos, accesos) sale también por correo
db.alNotificarSeguridad = item => {
  NotificacionesService.seguridadCuenta(item.destinatario, item.asunto, item.mensaje)
    .then(r => {
      item.estado = !r ? 'SIMULADO' : r.ok ? (r.simulado ? 'SIMULADO' : 'ENVIADO') : 'ERROR';
      item.error = r?.error;
      db.saveToDisk();
    })
    .catch(err => { item.estado = 'ERROR'; item.error = String(err?.message || err); });
};

/** Oculta códigos y contraseñas de un aviso antes de mostrarlo en pantalla */
export function ocultarSecretos<T extends { mensaje?: string; asunto?: string; codigo_otp?: string }>(n: T): T {
  const tapar = (t?: string) => (t || '')
    .replace(/\[(\d{6})\]/g, '[••••••]')
    .replace(/(contraseña provisional es:?\s*)"[^"]*"/gi, '$1"••••••••"')
    .replace(/(token[^:\[]*:?\s*)\[[^\]]*\]/gi, '$1[••••••]');
  return { ...n, asunto: tapar(n.asunto), mensaje: tapar(n.mensaje), codigo_otp: n.codigo_otp ? '••••••' : undefined };
}
