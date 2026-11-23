import crypto from 'crypto';

const secret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex'));
if (!secret) {
  throw new Error('Falta SESSION_SECRET para firmar los enlaces de aprobación.');
}

export type AccionAprobacion = 'aprobar' | 'rechazar';
export const VIGENCIA_ENLACE_MS = 72 * 60 * 60 * 1000;

const firmar = (payload: string) =>
  crypto.createHmac('sha256', secret).update(`aprobacion-registro:${payload}`).digest('base64url');

export const huellaCorreo = (correo: string) =>
  crypto.createHash('sha256').update(correo.trim().toLowerCase()).digest('hex');

export function crearTokenAprobacion(idUsuario: number, correo: string, accion: AccionAprobacion, ahora = Date.now()): string {
  if (!Number.isSafeInteger(idUsuario) || idUsuario <= 0) throw new Error('El id de usuario no es válido.');
  const payload = `${accion}.${idUsuario}.${ahora + VIGENCIA_ENLACE_MS}.${huellaCorreo(correo)}`;
  return `${Buffer.from(payload).toString('base64url')}.${firmar(payload)}`;
}

export function verificarTokenAprobacion(
  token: unknown,
  ahora = Date.now()
): { accion: AccionAprobacion; idUsuario: number; huella: string } | null {
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
  const [accion, idTexto, expiraTexto, huella] = campos;
  const idUsuario = Number(idTexto);
  const expira = Number(expiraTexto);
  if (accion !== 'aprobar' && accion !== 'rechazar') return null;
  if (!/^[1-9]\d*$/.test(idTexto) || !Number.isSafeInteger(idUsuario)) return null;
  if (!/^\d+$/.test(expiraTexto) || !Number.isSafeInteger(expira) || ahora >= expira) return null;
  if (!/^[a-f0-9]{64}$/.test(huella)) return null;

  return { accion, idUsuario, huella };
}
