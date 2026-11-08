/**
 * Cliente de Siigo Nube API (https://api.siigo.com).
 *
 *  - POST /auth                        { username, access_key } + encabezado Partner-Id → access_token (24 h)
 *  - GET  /v1/taxes                     impuestos y retenciones configurados en la empresa
 *  - GET  /v1/payment-types?document_type=FC   medios de pago (bancos / caja) para facturas de compra
 *  - GET  /v1/document-types?type=FC    tipos de documento de compra (ej. FC-1)
 *  - POST /v1/purchases                 registra una factura de compra
 *
 * Sin credenciales no se simula nada: se informa que la empresa no está conectada.
 */
import type { Factura } from '../domain/types.ts';

const SIIGO_BASE = (process.env.SIIGO_API_BASE || 'https://api.siigo.com').replace(/\/v1\/?$/, '');
const PARTNER_ID = process.env.SIIGO_PARTNER_ID || 'ConsolaTLM';

export interface CredencialesSiigo {
  username: string;
  access_key: string;
}

export interface ImpuestoSiigo {
  id: number;
  name: string;
  type: string;
  percentage: number;
  active?: boolean;
}

export interface MedioPagoSiigo {
  id: number;
  name: string;
  type?: string;
  active?: boolean;
}

export interface SiigoSyncResponse {
  status: 'success' | 'error' | 'omitida';
  factura_num: string;
  nit_tercero?: string;
  proveedor?: string;
  siigo_id?: string;
  siigo_nombre?: string;
  mensaje: string;
  payloadSent?: any;
  detalle_siigo?: any;
}

export class SiigoError extends Error {
  constructor(message: string, public status?: number, public detalle?: any) {
    super(message);
  }
}

/** Traduce los errores de Siigo ({ Errors: [{ Code, Message, Params }] }) a un texto legible. */
function mensajeErrorSiigo(cuerpo: any, status: number): string {
  const errores = cuerpo?.Errors || cuerpo?.errors;
  if (Array.isArray(errores) && errores.length) {
    return errores.map((e: any) => [e.Message || e.message, e.Params ? `(${[].concat(e.Params).join(', ')})` : ''].filter(Boolean).join(' ')).join(' | ');
  }
  if (status === 401) return 'Credenciales de Siigo inválidas o vencidas.';
  if (status === 429) return 'Siigo limitó las solicitudes (demasiadas por minuto). Intente de nuevo en unos segundos.';
  return cuerpo?.message || cuerpo?.Message || `Siigo respondió HTTP ${status}.`;
}

export class SiigoService {
  private tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
  private catalogoCache: Map<string, { impuestos: ImpuestoSiigo[]; medios: MedioPagoSiigo[]; at: number }> = new Map();

  // ------------------------------------------------------------------
  // Autenticación
  // ------------------------------------------------------------------
  public async autenticar(cred: CredencialesSiigo, forzar = false): Promise<string> {
    if (!cred?.username || !cred?.access_key) throw new SiigoError('La empresa no tiene usuario y Access Key de Siigo configurados.');
    const clave = `${cred.username}|${cred.access_key}`;
    const cache = this.tokenCache.get(clave);
    if (!forzar && cache && cache.expiresAt > Date.now() + 60_000) return cache.token;

    let res: Response;
    try {
      res = await fetch(`${SIIGO_BASE}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Partner-Id': PARTNER_ID },
        body: JSON.stringify({ username: cred.username, access_key: cred.access_key })
      });
    } catch (err: any) {
      throw new SiigoError(`No se pudo conectar con Siigo (${err.message}).`);
    }
    const cuerpo: any = await res.json().catch(() => ({}));
    if (!res.ok || !cuerpo.access_token) {
      throw new SiigoError(mensajeErrorSiigo(cuerpo, res.status), res.status, cuerpo);
    }
    const segundos = Number(cuerpo.expires_in) || 86400;
    this.tokenCache.set(clave, { token: cuerpo.access_token, expiresAt: Date.now() + segundos * 1000 });
    return cuerpo.access_token;
  }

  private async llamar<T = any>(cred: CredencialesSiigo, metodo: string, ruta: string, cuerpo?: unknown, reintento = true): Promise<T> {
    const token = await this.autenticar(cred);
    const res = await fetch(`${SIIGO_BASE}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'Partner-Id': PARTNER_ID, Authorization: `Bearer ${token}` },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined
    });
    if (res.status === 401 && reintento) {
      await this.autenticar(cred, true);
      return this.llamar<T>(cred, metodo, ruta, cuerpo, false);
    }
    const datos: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new SiigoError(mensajeErrorSiigo(datos, res.status), res.status, datos);
    return datos as T;
  }

  /** Prueba las credenciales contra Siigo (no guarda nada). */
  public async testConnection(username?: string, accessKey?: string): Promise<{ ok: boolean; message: string; user?: string }> {
    if (!username || !accessKey) {
      return { ok: false, message: 'Debe ingresar el usuario API (correo) y la Access Key de Siigo Nube.' };
    }
    try {
      await this.autenticar({ username, access_key: accessKey }, true);
      return { ok: true, message: `Conexión verificada con Siigo Nube para ${username}.`, user: username };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  }

  // ------------------------------------------------------------------
  // Catálogos de la empresa
  // ------------------------------------------------------------------
  public async catalogos(cred: CredencialesSiigo, forzar = false): Promise<{ impuestos: ImpuestoSiigo[]; medios: MedioPagoSiigo[] }> {
    const clave = cred.username;
    const cache = this.catalogoCache.get(clave);
    if (!forzar && cache && Date.now() - cache.at < 10 * 60_000) return cache;
    const [impuestos, medios] = await Promise.all([
      this.llamar<any[]>(cred, 'GET', '/v1/taxes'),
      this.llamar<any[]>(cred, 'GET', '/v1/payment-types?document_type=FC')
    ]);
    const limpio = {
      impuestos: (Array.isArray(impuestos) ? impuestos : []).filter(t => t.active !== false).map(t => ({ id: Number(t.id), name: String(t.name), type: String(t.type || ''), percentage: Number(t.percentage || 0), active: t.active })),
      medios: (Array.isArray(medios) ? medios : []).filter(m => m.active !== false).map(m => ({ id: Number(m.id), name: String(m.name), type: m.type, active: m.active }))
    };
    this.catalogoCache.set(clave, { ...limpio, at: Date.now() });
    return limpio;
  }

  /** Clasifica los impuestos de Siigo por tipo para los desplegables. */
  public clasificarImpuestos(impuestos: ImpuestoSiigo[]) {
    const t = (x: ImpuestoSiigo) => `${x.type} ${x.name}`.toLowerCase();
    return {
      iva: impuestos.filter(x => /^iva/i.test(x.type) || (/\biva\b/.test(t(x)) && !/rete|retenci/.test(t(x)))),
      retefuente: impuestos.filter(x => /retefuente|fuente|rtefte/.test(t(x))),
      reteica: impuestos.filter(x => /reteica|\bica\b|industria/.test(t(x))),
      reteiva: impuestos.filter(x => /reteiva/.test(t(x)) || (/rete/.test(t(x)) && /\biva\b/.test(t(x)) && !/fuente/.test(t(x))))
    };
  }

  // ------------------------------------------------------------------
  // Catálogos estáticos (compatibilidad con rutas anteriores)
  // ------------------------------------------------------------------
  public getMediosPagoCatalog() {
    return [] as MedioPagoSiigo[];
  }

  public getImpuestosCatalog() {
    return [] as ImpuestoSiigo[];
  }

  // ------------------------------------------------------------------
  // Envío de facturas de compra
  // ------------------------------------------------------------------
  public construirCompra(
    f: Factura,
    opciones: { documentId: number; medioPagoId?: number | null; impuestos: ImpuestoSiigo[] }
  ) {
    const clasif = this.clasificarImpuestos(opciones.impuestos);
    const nit = (f.nit_tercero || '').split('-')[0].replace(/[^\d]/g, '');
    const m = (f.factura_num || '').match(/^([A-Za-z]*)[-\s]?(\d+)$/);
    const prefijo = m ? m[1] : '';
    const numero = m ? m[2] : (f.factura_num || '').replace(/[^\d]/g, '');

    const idsRetencion = [f.id_retencion, f.id_reteica, f.id_reteiva].filter((x): x is number => Number.isInteger(x) && (x as number) > 0);
    const lineas = f.items && f.items.length ? f.items : [{ descripcion_item: f.descripcion_item, cantidad: f.cantidad, valor_unitario: f.valor_unitario, subtotal: Math.abs(f.subtotal), iva: Math.abs(f.iva), iva_porc: f.subtotal ? Math.round((f.iva / f.subtotal) * 100) : 0 } as any];

    const items = lineas.map((l: any) => {
      const porcIva = l.iva_porc ?? (l.subtotal ? Math.round((l.iva / l.subtotal) * 100) : 0);
      const iva = porcIva > 0 ? clasif.iva.find(x => Math.abs(x.percentage - porcIva) < 0.01) : undefined;
      const taxes = [...(iva ? [{ id: iva.id }] : []), ...idsRetencion.map(id => ({ id }))];
      const cantidad = Number(l.cantidad) || 1;
      return {
        type: 'Account',
        code: l.cuenta_contable || f.cuenta_gasto,
        description: String(l.descripcion_item || f.descripcion_item || 'Compra').substring(0, 100),
        quantity: cantidad,
        price: Math.round(((Number(l.subtotal) || 0) / cantidad) * 100) / 100,
        discount: 0,
        ...(taxes.length ? { taxes } : {})
      };
    });

    const total = Math.round(((f.total ?? f.subtotal + f.iva) - this.totalRetenido(f)) * 100) / 100;
    return {
      document: { id: opciones.documentId },
      date: f.fecha,
      supplier: { identification: nit, branch_office: 0 },
      provider_invoice: { prefix: prefijo, number: numero },
      observations: `Factura ${f.factura_num} cargada desde Consola TLM (CUFE ${String(f.cufe_hash || '').substring(0, 20)}…)`,
      items,
      payments: [
        {
          id: opciones.medioPagoId || f.id_medio_pago,
          value: total,
          due_date: f.fecha_vencimiento || f.fecha
        }
      ]
    };
  }

  private totalRetenido(f: Factura) {
    const rf = Math.abs(f.retencion_valor || 0);
    const ica = Math.round(Math.abs(f.subtotal || 0) * (f.reteica_tarifa || 0) / 1000);
    const riva = Math.round(Math.abs(f.iva || 0) * (f.reteiva_porc || 0) / 100);
    return rf + ica + riva;
  }

  public async enviarCompra(
    cred: CredencialesSiigo,
    f: Factura,
    opciones: { documentId: number; medioPagoId?: number | null }
  ): Promise<SiigoSyncResponse> {
    const base = { factura_num: f.factura_num, nit_tercero: f.nit_tercero, proveedor: f.proveedor };
    if (f.tipo_operacion === 'VENTA') {
      return { ...base, status: 'omitida', mensaje: 'Es una factura de venta; solo se transmiten facturas de compra.' };
    }
    if (f.estado_revision === 'SINCRONIZADA_SIIGO' && f.siigo_id) {
      return { ...base, status: 'omitida', siigo_id: f.siigo_id, mensaje: `Ya fue transmitida (${f.siigo_id}).` };
    }
    // El payload se conserva también si Siigo rechaza la factura, para poder diagnosticar el error
    let payload: any;
    try {
      const { impuestos } = await this.catalogos(cred);
      payload = this.construirCompra(f, { documentId: opciones.documentId, medioPagoId: opciones.medioPagoId, impuestos });
      if (!payload.payments[0].id) {
        return { ...base, status: 'error', mensaje: 'Falta el medio de pago (banco) de Siigo para esta factura.', payloadSent: payload };
      }
      const r: any = await this.llamar(cred, 'POST', '/v1/purchases', payload);
      return { ...base, status: 'success', siigo_id: r?.id, siigo_nombre: r?.name, mensaje: `Registrada en Siigo como ${r?.name || r?.id}.`, payloadSent: payload };
    } catch (err: any) {
      // detalle_siigo: respuesta original de Siigo (códigos, campos y parámetros del error)
      return { ...base, status: 'error', mensaje: err.message, payloadSent: payload, detalle_siigo: err?.detalle };
    }
  }

  /** Compatibilidad con la ruta anterior /siigo/enviar-facturas */
  public async transmitInvoiceToSiigo(factura: Factura, documentId: number = 24, medioPagoId?: number, cred?: CredencialesSiigo): Promise<SiigoSyncResponse> {
    if (!cred) {
      return { status: 'error', factura_num: factura.factura_num, mensaje: 'La empresa no tiene credenciales de Siigo configuradas.' };
    }
    return this.enviarCompra(cred, factura, { documentId, medioPagoId });
  }
}

export const siigoService = new SiigoService();
