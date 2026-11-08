/**
 * Envío de correo electrónico de la Consola TLM.
 *
 * Proveedores (se elige con CORREO_PROVEEDOR o se detecta por las variables definidas):
 *   GMAIL_API  → Gmail / Google Workspace por HTTPS. Funciona en el plan gratuito de Render (que bloquea SMTP).
 *                Con cuenta de servicio + delegación de dominio (GOOGLE_SERVICE_ACCOUNT_JSON y CORREO_REMITENTE)
 *                o con OAuth (GMAIL_OAUTH_* o GOOGLE_OAUTH_*, con el permiso gmail.send).
 *   RESEND     → API HTTPS de Resend (RESEND_API_KEY). También funciona en el plan gratuito de Render.
 *   SMTP       → Cualquier servidor SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS). Requiere plan pago en Render.
 *   SIMULADO   → Sin proveedor: no sale ningún correo, solo queda registrado en el historial.
 */
import fs from 'fs';
import { JWT, OAuth2Client } from 'google-auth-library';
import { pool } from '../../db/index.ts';

export type ProveedorCorreo = 'GMAIL_API' | 'RESEND' | 'SMTP' | 'SIMULADO';

export interface AdjuntoCorreo {
  nombre: string;
  contenido: Buffer;
  mime?: string;
}

export interface MensajeCorreo {
  para: string[];
  cc?: string[];
  asunto: string;
  html: string;
  texto?: string;
  adjuntos?: AdjuntoCorreo[];
  /** Para el historial */
  evento?: string;
  id_empresa?: number;
}

export interface ResultadoEnvio {
  ok: boolean;
  proveedor: ProveedorCorreo;
  id?: string;
  error?: string;
  simulado?: boolean;
}

export interface RegistroEnvio {
  id: number | string;
  fecha: string;
  evento: string;
  id_empresa?: number | null;
  para: string;
  asunto: string;
  estado: 'ENVIADO' | 'ERROR' | 'SIMULADO';
  proveedor: ProveedorCorreo;
  error?: string | null;
  adjuntos: number;
}

const env = (k: string) => (process.env[k] || '').trim();
const RE_CORREO = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const correoValido = (c: string) => RE_CORREO.test((c || '').trim());

function cuentaServicio(): { client_email: string; private_key: string } | null {
  let raw = env('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!raw && env('GOOGLE_APPLICATION_CREDENTIALS')) {
    try { raw = fs.readFileSync(env('GOOGLE_APPLICATION_CREDENTIALS'), 'utf-8'); } catch { return null; }
  }
  if (!raw) return null;
  try {
    const texto = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8');
    const sa = JSON.parse(texto);
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

function oauthGmail(): { id: string; secreto: string; refresh: string } | null {
  const id = env('GMAIL_OAUTH_CLIENT_ID') || env('GOOGLE_OAUTH_CLIENT_ID');
  const secreto = env('GMAIL_OAUTH_CLIENT_SECRET') || env('GOOGLE_OAUTH_CLIENT_SECRET');
  const refresh = env('GMAIL_OAUTH_REFRESH_TOKEN') || env('GOOGLE_OAUTH_REFRESH_TOKEN');
  return id && secreto && refresh ? { id, secreto, refresh } : null;
}

class CorreoServiceClass {
  private historialMemoria: RegistroEnvio[] = [];
  private tablaLista: Promise<boolean> | null = null;
  private gmailAuth: JWT | OAuth2Client | null = null;
  private smtp: any = null;

  // ---------------- Configuración ----------------
  remitente(): string {
    return env('CORREO_REMITENTE') || env('GOOGLE_OAUTH_ACCOUNT_EMAIL') || env('SMTP_USER') || '';
  }

  nombreRemitente(): string {
    return env('CORREO_REMITENTE_NOMBRE') || 'Consola TLM';
  }

  proveedor(): ProveedorCorreo {
    const forzado = env('CORREO_PROVEEDOR').toUpperCase().replace(/[^A-Z_]/g, '');
    if (['GMAIL_API', 'GMAIL', 'RESEND', 'SMTP', 'SIMULADO', 'NINGUNO'].includes(forzado)) {
      if (forzado === 'GMAIL') return 'GMAIL_API';
      if (forzado === 'NINGUNO') return 'SIMULADO';
      return forzado as ProveedorCorreo;
    }
    if (env('RESEND_API_KEY')) return 'RESEND';
    if (env('SMTP_HOST')) return 'SMTP';
    if (env('CORREO_REMITENTE') && (cuentaServicio() || oauthGmail())) return 'GMAIL_API';
    if (env('GMAIL_OAUTH_REFRESH_TOKEN')) return 'GMAIL_API';
    return 'SIMULADO';
  }

  /** Estado para la interfaz (sin exponer secretos) */
  estado() {
    const proveedor = this.proveedor();
    const remitente = this.remitente();
    const faltantes: string[] = [];
    let detalle = '';
    if (proveedor === 'GMAIL_API') {
      const sa = cuentaServicio();
      const oauth = oauthGmail();
      if (!remitente) faltantes.push('CORREO_REMITENTE');
      if (!sa && !oauth) faltantes.push('GOOGLE_SERVICE_ACCOUNT_JSON o GMAIL_OAUTH_*');
      detalle = oauth && (env('GMAIL_OAUTH_REFRESH_TOKEN') || !sa)
        ? 'Gmail API con OAuth (el token debe incluir el permiso gmail.send).'
        : sa ? `Gmail API con la cuenta de servicio ${sa.client_email}, enviando como ${remitente || '(sin remitente)'} mediante delegación de dominio (permiso https://www.googleapis.com/auth/gmail.send).` : '';
    } else if (proveedor === 'RESEND') {
      if (!remitente) faltantes.push('CORREO_REMITENTE (dominio verificado en Resend)');
      detalle = 'Resend por HTTPS.';
    } else if (proveedor === 'SMTP') {
      if (!env('SMTP_USER') || !env('SMTP_PASS')) faltantes.push('SMTP_USER / SMTP_PASS');
      detalle = `SMTP ${env('SMTP_HOST')}:${env('SMTP_PORT') || '587'}. Ojo: el plan gratuito de Render bloquea los puertos SMTP.`;
    } else {
      detalle = 'No hay proveedor de correo configurado: los mensajes solo quedan en el historial.';
    }
    return {
      proveedor,
      configurado: proveedor !== 'SIMULADO' && faltantes.length === 0,
      remitente: remitente || null,
      nombre_remitente: this.nombreRemitente(),
      detalle,
      faltantes
    };
  }

  // ---------------- Envío ----------------
  async enviar(m: MensajeCorreo): Promise<ResultadoEnvio> {
    const para = [...new Set((m.para || []).map(c => c.trim().toLowerCase()).filter(correoValido))];
    const cc = [...new Set((m.cc || []).map(c => c.trim().toLowerCase()).filter(c => correoValido(c) && !para.includes(c)))];
    const proveedor = this.proveedor();
    if (para.length === 0) {
      const r: ResultadoEnvio = { ok: false, proveedor, error: 'No hay destinatarios con un correo válido.' };
      await this.registrar(m, para, r);
      return r;
    }
    let r: ResultadoEnvio;
    try {
      if (proveedor === 'SIMULADO') {
        console.log(`[Correo] (simulado) "${m.asunto}" → ${para.join(', ')}`);
        r = { ok: true, proveedor, simulado: true };
      } else {
        const faltan = this.estado().faltantes;
        if (faltan.length) throw new Error(`Falta configurar: ${faltan.join(', ')}.`);
        const id = proveedor === 'RESEND' ? await this.enviarResend(m, para, cc)
          : proveedor === 'SMTP' ? await this.enviarSmtp(m, para, cc)
          : await this.enviarGmail(m, para, cc);
        r = { ok: true, proveedor, id };
      }
    } catch (err: any) {
      r = { ok: false, proveedor, error: String(err?.message || err).substring(0, 500) };
      console.warn(`[Correo] Error enviando "${m.asunto}" por ${proveedor}:`, r.error);
    }
    await this.registrar(m, [...para, ...cc], r);
    return r;
  }

  /** Envía sin bloquear la respuesta HTTP (los errores quedan en el historial) */
  enviarEnSegundoPlano(m: MensajeCorreo): void {
    this.enviar(m).catch(err => console.warn('[Correo] Error en segundo plano:', err));
  }

  private desde(): string {
    const nombre = this.nombreRemitente().replace(/"/g, '');
    return `"${nombre}" <${this.remitente()}>`;
  }

  private async enviarResend(m: MensajeCorreo, para: string[], cc: string[]): Promise<string> {
    const res = await fetch(env('RESEND_API_URL') || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.desde(),
        to: para,
        cc: cc.length ? cc : undefined,
        subject: m.asunto,
        html: m.html,
        text: m.texto,
        attachments: (m.adjuntos || []).map(a => ({ filename: a.nombre, content: a.contenido.toString('base64') }))
      })
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status}: ${data?.message || data?.error || res.statusText}`);
    return data?.id || '';
  }

  private async enviarSmtp(m: MensajeCorreo, para: string[], cc: string[]): Promise<string> {
    if (!this.smtp) {
      const nodemailer: any = await import('nodemailer');
      const puerto = Number(env('SMTP_PORT') || 587);
      this.smtp = (nodemailer.default || nodemailer).createTransport({
        host: env('SMTP_HOST'),
        port: puerto,
        secure: env('SMTP_SECURE') ? env('SMTP_SECURE') === 'true' : puerto === 465,
        auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
        connectionTimeout: 15000
      });
    }
    const info = await this.smtp.sendMail({
      from: this.desde(),
      to: para.join(', '),
      cc: cc.length ? cc.join(', ') : undefined,
      subject: m.asunto,
      html: m.html,
      text: m.texto,
      attachments: (m.adjuntos || []).map(a => ({ filename: a.nombre, content: a.contenido, contentType: a.mime }))
    });
    return info?.messageId || '';
  }

  private async tokenGmail(): Promise<string> {
    if (!this.gmailAuth) {
      const oauth = oauthGmail();
      const sa = cuentaServicio();
      // Si hay un refresh token específico de Gmail se prefiere; si no, la cuenta de servicio con delegación
      if (oauth && (env('GMAIL_OAUTH_REFRESH_TOKEN') || !sa)) {
        const c = new OAuth2Client(oauth.id, oauth.secreto);
        c.setCredentials({ refresh_token: oauth.refresh });
        this.gmailAuth = c;
      } else if (sa) {
        this.gmailAuth = new JWT({
          email: sa.client_email,
          key: sa.private_key,
          scopes: ['https://www.googleapis.com/auth/gmail.send'],
          subject: this.remitente()
        });
      } else {
        throw new Error('No hay credenciales de Google para Gmail API.');
      }
    }
    const t = await this.gmailAuth.getAccessToken();
    const token = typeof t === 'string' ? t : t?.token;
    if (!token) throw new Error('Google no entregó un token de acceso para Gmail.');
    return token;
  }

  private async enviarGmail(m: MensajeCorreo, para: string[], cc: string[]): Promise<string> {
    let token: string;
    try {
      token = await this.tokenGmail();
    } catch (err: any) {
      this.gmailAuth = null;
      const msg = String(err?.message || err);
      if (/unauthorized_client|not authorized|delegation/i.test(msg)) {
        throw new Error('La cuenta de servicio no tiene delegación de dominio para gmail.send. En la consola de administración de Google Workspace autorice su Client ID con el permiso https://www.googleapis.com/auth/gmail.send.');
      }
      if (/insufficient|scope/i.test(msg)) throw new Error('El token OAuth no incluye el permiso gmail.send. Genere un nuevo refresh token con ese permiso.');
      throw err;
    }
    const raw = construirMime({ desde: this.desde(), para, cc, asunto: m.asunto, html: m.html, texto: m.texto, adjuntos: m.adjuntos });
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') })
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || res.statusText;
      if (res.status === 403 && /scope|insufficient/i.test(msg)) throw new Error('Gmail rechazó el envío: el token no tiene el permiso gmail.send.');
      throw new Error(`Gmail ${res.status}: ${msg}`);
    }
    return data?.id || '';
  }

  // ---------------- Historial ----------------
  private asegurarTabla(): Promise<boolean> {
    if (!this.tablaLista) {
      this.tablaLista = pool.query(`CREATE TABLE IF NOT EXISTS correos_enviados (
          id SERIAL PRIMARY KEY,
          fecha TIMESTAMP DEFAULT now(),
          evento TEXT,
          id_empresa INTEGER,
          para TEXT,
          asunto TEXT,
          estado TEXT,
          proveedor TEXT,
          error TEXT,
          adjuntos INTEGER DEFAULT 0
        )`).then(() => true).catch(() => { this.tablaLista = null; return false; });
    }
    return this.tablaLista;
  }

  private async registrar(m: MensajeCorreo, destinatarios: string[], r: ResultadoEnvio) {
    const fila: RegistroEnvio = {
      id: `mem-${Date.now()}`,
      fecha: new Date().toISOString(),
      evento: m.evento || 'GENERAL',
      id_empresa: m.id_empresa ?? null,
      para: destinatarios.join(', ') || '(sin destinatarios)',
      asunto: m.asunto,
      estado: r.ok ? (r.simulado ? 'SIMULADO' : 'ENVIADO') : 'ERROR',
      proveedor: r.proveedor,
      error: r.error || null,
      adjuntos: m.adjuntos?.length || 0
    };
    this.historialMemoria.unshift(fila);
    this.historialMemoria.length = Math.min(this.historialMemoria.length, 200);
    if (await this.asegurarTabla()) {
      await pool.query(
        'INSERT INTO correos_enviados (evento, id_empresa, para, asunto, estado, proveedor, error, adjuntos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [fila.evento, fila.id_empresa, fila.para, fila.asunto, fila.estado, fila.proveedor, fila.error, fila.adjuntos]
      ).catch(() => {});
    }
  }

  async historial(idEmpresa?: number, limite = 100): Promise<RegistroEnvio[]> {
    if (await this.asegurarTabla()) {
      try {
        const r = idEmpresa
          ? await pool.query('SELECT * FROM correos_enviados WHERE id_empresa = $1 OR id_empresa IS NULL ORDER BY fecha DESC LIMIT $2', [idEmpresa, limite])
          : await pool.query('SELECT * FROM correos_enviados ORDER BY fecha DESC LIMIT $1', [limite]);
        return r.rows.map((x: any) => ({ ...x, fecha: new Date(x.fecha).toISOString() }));
      } catch {}
    }
    return this.historialMemoria.filter(h => !idEmpresa || h.id_empresa === idEmpresa || h.id_empresa == null).slice(0, limite);
  }
}

// ---------------- MIME (RFC 2822) para Gmail API ----------------
const codificarEncabezado = (t: string) => (/^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t).toString('base64')}?=`);
const enLineas = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

export function construirMime(p: { desde: string; para: string[]; cc?: string[]; asunto: string; html: string; texto?: string; adjuntos?: AdjuntoCorreo[] }): string {
  const limiteMixto = `mix_${Math.random().toString(36).slice(2)}`;
  const limiteAlt = `alt_${Math.random().toString(36).slice(2)}`;
  const nombreDesde = p.desde.match(/^"(.*)" <(.*)>$/);
  const desde = nombreDesde ? `${codificarEncabezado(nombreDesde[1])} <${nombreDesde[2]}>` : p.desde;
  const lineas = [
    `From: ${desde}`,
    `To: ${p.para.join(', ')}`,
    ...(p.cc?.length ? [`Cc: ${p.cc.join(', ')}`] : []),
    `Subject: ${codificarEncabezado(p.asunto)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${limiteMixto}"`,
    '',
    `--${limiteMixto}`,
    `Content-Type: multipart/alternative; boundary="${limiteAlt}"`,
    '',
    `--${limiteAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    enLineas(Buffer.from(p.texto || p.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).toString('base64')),
    `--${limiteAlt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    enLineas(Buffer.from(p.html).toString('base64')),
    `--${limiteAlt}--`
  ];
  for (const a of p.adjuntos || []) {
    const nombre = codificarEncabezado(a.nombre);
    lineas.push(
      `--${limiteMixto}`,
      `Content-Type: ${a.mime || 'application/octet-stream'}; name="${nombre}"`,
      `Content-Disposition: attachment; filename="${nombre}"`,
      'Content-Transfer-Encoding: base64',
      '',
      enLineas(a.contenido.toString('base64'))
    );
  }
  lineas.push(`--${limiteMixto}--`, '');
  return lineas.join('\r\n');
}

export const CorreoService = new CorreoServiceClass();
