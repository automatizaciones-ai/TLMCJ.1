import crypto from 'crypto';
import { huellaCorreo } from './aprobacionToken.ts';

const secret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex'));
if (!secret) {
  throw new Error('Falta SESSION_SECRET para firmar los enlaces de recuperación.');
}

export const VIGENCIA_SOLICITUD_RECUPERACION_MS = 60 * 60 * 1000;

const firmar = (payload: string) =>
  crypto.createHmac('sha256', secret).update(`aprobacion-recuperacion:${payload}`).digest('base64url');

export function crearTokenAprobacionRecuperacion(idUsuario: number, correo: string, ahora = Date.now()): string {
  if (!Number.isSafeInteger(idUsuario) || idUsuario <= 0) throw new Error('El id de usuario no es válido.');
  const expira = ahora + VIGENCIA_SOLICITUD_RECUPERACION_MS;
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${idUsuario}.${expira}.${huellaCorreo(correo)}.${nonce}`;
  return `${Buffer.from(payload).toString('base64url')}.${firmar(payload)}`;
}

export function verificarTokenAprobacionRecuperacion(
  token: unknown,
  ahora = Date.now()
): { idUsuario: number; huella: string } | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const partes = token.split('.');
  if (partes.length !== 2 || !partes[0] || !/^[A-Za-z0-9_-]+$/.test(partes[1])) return null;

  const [codificado, firma] = partes;
  const payload = Buffer.from(codificado, 'base64url').toString('utf8');
  if (Buffer.from(payload).toString('base64url') !== codificado) return null;

  const esperado = Buffer.from(firmar(payload));
  const recibido = Buffer.from(firma);
  if (esperado.length !== recibido.length || !crypto.timingSafeEqual(esperado, recibido)) return null;

  const campos = payload.split('.');
  if (campos.length !== 4) return null;
  const [idTexto, expiraTexto, huella, nonce] = campos;
  const idUsuario = Number(idTexto);
  const expira = Number(expiraTexto);
  if (!/^[1-9]\d*$/.test(idTexto) || !Number.isSafeInteger(idUsuario)) return null;
  if (!/^\d+$/.test(expiraTexto) || !Number.isSafeInteger(expira) || ahora >= expira) return null;
  if (!/^[a-f0-9]{64}$/.test(huella) || !/^[a-f0-9]{32}$/.test(nonce)) return null;

  return { idUsuario, huella };
}
