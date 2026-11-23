import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { db } from '../storage/dataStore.ts';
import { Usuario } from '../domain/types.ts';

const COOKIE_NAME = 'tlm_session';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const isProd = process.env.NODE_ENV === 'production';

const secret = process.env.SESSION_SECRET || (isProd ? '' : crypto.randomBytes(32).toString('hex'));
if (!secret) {
  throw new Error('Falta SESSION_SECRET en el entorno de producción. Define una cadena larga y aleatoria en .env o en el panel de tu hosting.');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie || '';
  const found = header.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

// Crea una sesión firmada (HMAC) y la guarda en una cookie httpOnly.
export function startSession(res: Response, usuario: Usuario) {
  const expires = Date.now() + TTL_MS;
  const payload = `${usuario.id_usuario}.${expires}`;
  res.cookie(COOKIE_NAME, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: TTL_MS,
    path: '/'
  });
}

export function endSession(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Devuelve el usuario de la sesión actual, o null si no hay sesión válida.
export function getSessionUser(req: Request): Usuario | null {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, expires, signature] = parts;
  const payload = `${id}.${expires}`;

  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  if (Date.now() > Number(expires)) return null;

  const user = db.usuarios.find(u => u.id_usuario === Number(id));
  return user && user.activo ? user : null;
}

export function isAdminUser(user: Usuario | null | undefined): boolean {
  return !!user && (user.rol === 'Administrador' || user.permisos?.gestion_usuarios === true);
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ detail: "Debes iniciar sesión para continuar." });
  }
  (req as any).usuario = user;
  next();
}

// Rutas que no requieren sesión (el resto de /api/v1 sí)
const RUTAS_PUBLICAS = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/sesion',
  '/auth/register',
  '/auth/register/verify',
  '/auth/register/resend-verification',
  '/auth/aprobar-por-correo',
  '/auth/recuperar-password/solicitar-codigo',
  '/auth/recuperar-password/verificar-y-cambiar'
]);

// Solo administradores: usuarios, configuración del sistema, correo, almacenamiento y notificaciones de seguridad
function requiereAdmin(req: Request): boolean {
  if (req.path === '/auth/notificaciones-seguridad') return true;
  if (req.path.startsWith('/sistema/')) return true;
  if (req.method !== 'GET' && (req.path.startsWith('/auth/usuarios') || req.path.startsWith('/correo/') || req.path.startsWith('/almacenamiento/'))) return true;
  return req.method !== 'GET' && /\/(almacenamiento|notificaciones)(\/|$)/.test(req.path);
}

// Guardia de /api/v1: exige sesión y, para acciones de administración, rol de administrador
export function guardarApi(req: Request, res: Response, next: NextFunction) {
  if (RUTAS_PUBLICAS.has(req.path)) return next();
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ detail: "Debes iniciar sesión para continuar." });
  }
  if (user.requiere_cambio_password && req.path !== '/auth/cambiar-password') {
    return res.status(403).json({ detail: 'Debes cambiar tu contraseña antes de continuar.' });
  }
  if (requiereAdmin(req) && !isAdminUser(user)) {
    return res.status(403).json({ detail: "Solo un administrador puede realizar esta acción." });
  }
  (req as any).usuario = user;
  next();
}
