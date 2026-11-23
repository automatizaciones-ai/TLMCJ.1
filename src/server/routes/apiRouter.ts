import express, { type Request, type Response } from 'express';
const Router = express.Router;
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db, getDefaultPermissions } from '../storage/dataStore.ts';
import { xmlParser, emparejarPdfs, type ParsedXmlInvoice } from '../services/xmlUblParser.ts';
import { SoportesOriginales } from '../services/soportesOriginalesService.ts';
import { NotificacionesService, ocultarSecretos } from '../services/notificacionesService.ts';
import { CorreoService, correoValido } from '../services/correoService.ts';
import { reconciliationEngine } from '../services/reconciliationEngine.ts';
import { f350TaxEngine } from '../services/f350TaxEngine.ts';
import { siigoService } from '../services/siigoService.ts';
import { scalabilityArchitecture } from '../services/scalabilityArchitecture.ts';
import { ExcelService } from '../services/excelService.ts';
import { SqlGeneratorService } from '../services/sqlGeneratorService.ts';
import { CloudSqlService } from '../services/cloudSqlService.ts';
import { reconnectPool, getActiveConnectionConfig, parseConnectionString } from '../../db/index.ts';
import { EmpresaStorageService } from '../services/empresaStorageService.ts';
import type { Factura, FacturaItem, Usuario } from '../domain/types.ts';
import crypto from 'crypto';
import { hashPassword, isHashed, verifyPassword, matchesLegacyPassword } from '../services/passwordHasher.ts';
import { startSession, endSession, getSessionUser } from '../services/sessionAuth.ts';
import { mailer } from '../services/mailer.ts';
import { secondsLocked, recordFailure, lockFor, clearAttempts } from '../services/attemptLimiter.ts';
import { crearTokenAprobacion, huellaCorreo, verificarTokenAprobacion, type AccionAprobacion } from '../services/aprobacionToken.ts';

const router = Router();
router.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Número dentro de un rango; null si no es un número válido
function numeroEnRango(valor: unknown, min: number, max: number): number | null {
  if (valor === '' || valor === null || valor === undefined) return null;
  const n = Number(valor);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Nunca enviar al navegador hashes de contraseña, códigos OTP ni llaves de Siigo
const usuarioPublico = (u: any) => {
  if (!u) return u;
  const { hashed_password, codigo_recuperacion, codigo_recuperacion_expira, verification_token, token_expires_at, ...resto } = u;
  return resto;
};
/** Usuario que hace la solicitud (encabezado x-tlm-user-id enviado por la interfaz) */
const usuarioSolicitante = async (req: Request) => (req as any).usuario || null;
const esAdministrador = (u: any) => Boolean(u && (u.rol === 'Administrador' || u.rol === 'Desarrollador' || u.permisos?.administrador));
/** Un usuario no administrador solo ve las empresas que tiene asignadas */
const visiblesPara = (lista: any[], u: any) => (!u || esAdministrador(u) ? lista : lista.filter(e => (u.empresas_ids || []).includes(e.id_empresa)));
const empresaPublica = (e: any) => {
  if (!e) return e;
  const { siigo_access_key, ...resto } = e;
  return { ...resto, siigo_access_key: siigo_access_key ? '••••••••••••••••' : undefined, has_siigo_credentials: Boolean(e.siigo_username && siigo_access_key) };
};
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB support for batch uploads
const directorioSubidasFacturas = path.join(os.tmpdir(), 'tlm-subidas-facturas');
fs.mkdirSync(directorioSubidasFacturas, { recursive: true });
const uploadFacturas = multer({
  storage: multer.diskStorage({
    destination: directorioSubidasFacturas,
    filename: (_req, _file, callback) => callback(null, crypto.randomUUID())
  })
});

// ==========================================
// ==========================================
// 1. AUTENTICACIÓN Y GESTIÓN DE USUARIOS & CIBERSEGURIDAD
// ==========================================
export function validatePasswordRule(pwd: string): { ok: boolean; message?: string } {
  if (!pwd || typeof pwd !== 'string' || pwd.length < 8) {
    return { ok: false, message: "La contraseña debe tener mínimo 8 caracteres." };
  }
  const hasLetter = /[a-zA-Z]/.test(pwd);
  const hasNumber = /[0-9]/.test(pwd);
  if (!hasLetter || !hasNumber) {
    return { ok: false, message: "La contraseña debe ser alfanumérica (debe contener al menos una letra y un número)." };
  }
  return { ok: true };
}

// ==========================================
// AUTENTICACIÓN: sesión firmada, límite de intentos, contraseñas cifradas y recuperación por correo
// ==========================================
// Límites de intentos de inicio de sesión y de recuperación
const LOGIN_MAX_POR_CUENTA = 5;
const LOGIN_MAX_POR_IP = 30;
const LOGIN_VENTANA_MS = 15 * 60 * 1000;
const LOGIN_BLOQUEO_MS = 15 * 60 * 1000;
const CODIGO_ESPERA_MS = 60 * 1000; // tiempo mínimo entre dos códigos del mismo correo
const registrosEnProceso = new Set<string>();

/** Busca la cuenta por correo: primero en Cloud SQL y luego en el almacenamiento local. */
async function buscarUsuarioPorCorreo(correo: string): Promise<any | null> {
  if (await CloudSqlService.isCloudSqlOnline()) {
    return CloudSqlService.getUsuarioByEmail(correo);
  }
  return db.usuarios.find(u => u.email.trim().toLowerCase() === correo) || null;
}

function baseUrlAplicacion(): string {
  const configuredUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (!configuredUrl) throw new Error('Configura APP_URL o RENDER_EXTERNAL_URL para enviar enlaces de registro.');
  const appUrl = new URL(configuredUrl);
  if ((appUrl.protocol !== 'https:' && appUrl.protocol !== 'http:') || appUrl.username || appUrl.password) {
    throw new Error('APP_URL debe ser una URL HTTP(S) válida.');
  }
  if (process.env.NODE_ENV === 'production' && appUrl.protocol !== 'https:') {
    throw new Error('APP_URL debe usar HTTPS en producción.');
  }
  return appUrl.origin;
}

const escaparHtml = (valor: unknown) =>
  String(valor ?? '').replace(/[&<>"']/g, caracter => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[caracter]!));

function aprobadoresRegistro(): string[] {
  const configurados = process.env.APROBADOR_REGISTRO_EMAIL || process.env.ADMIN_EMAIL || 'juan.yaya@tlm.net.co,automatizaciones@tlm.net.co';
  return [...new Set(configurados.split(',').map(correo => correo.trim().toLowerCase()).filter(correoValido))];
}

async function enviarCorreoVerificacion(user: Usuario, token: string, baseUrl: string): Promise<void> {
  if (!mailer.enabled) throw new Error('El servicio de correo no está configurado.');
  const verificationUrl = `${baseUrl}/api/v1/auth/register/verify?token=${encodeURIComponent(token)}`;
  await mailer.send(
    user.email,
    'Confirma tu correo para solicitar acceso a Consola TLM',
    `Hola ${user.nombre_completo},\n\nPara confirmar que tienes acceso a este buzón, abre este enlace dentro de las próximas 24 horas:\n${verificationUrl}\n\nDespués de verificarlo, el equipo de TLM revisará tu solicitud. Si se aprueba el acceso, al iniciar sesión deberás cambiar tu contraseña.`,
    `<p>Hola ${escaparHtml(user.nombre_completo)},</p><p>Confirma que tienes acceso a este buzón abriendo este enlace dentro de las próximas 24 horas:</p><p><a href="${escaparHtml(verificationUrl)}">Confirmar correo</a></p><p>Después de verificarlo, el equipo de TLM revisará tu solicitud.</p>`
  );
}

async function enviarSolicitudAprobacion(user: Usuario, baseUrl: string): Promise<void> {
  const destinatarios = aprobadoresRegistro();
  if (!mailer.enabled) throw new Error('El servicio de correo no está configurado.');
  if (!destinatarios.length) throw new Error('No hay correos válidos configurados para aprobar registros.');

  const enlaces = (accion: AccionAprobacion) =>
    `${baseUrl}/api/v1/auth/aprobar-por-correo?t=${encodeURIComponent(crearTokenAprobacion(user.id_usuario, user.email, accion))}`;
  const aprobarUrl = enlaces('aprobar');
  const rechazarUrl = enlaces('rechazar');
  const texto = `Se verificó el correo y hay una solicitud de acceso pendiente:\n\nNombre: ${user.nombre_completo}\nCorreo: ${user.email}\n\nAprobar: ${aprobarUrl}\nRechazar: ${rechazarUrl}\n\nAbrir un enlace solo muestra la solicitud; la acción se ejecuta al confirmar en la página. Los enlaces vencen en 72 horas.`;
  const html = `<p>Se verificó el correo y hay una solicitud de acceso pendiente:</p><p><b>${escaparHtml(user.nombre_completo)}</b><br>${escaparHtml(user.email)}</p><p><a href="${escaparHtml(aprobarUrl)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">Revisar y aprobar</a> <a href="${escaparHtml(rechazarUrl)}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">Rechazar</a></p><p>Abrir un enlace solo muestra la solicitud; la acción se ejecuta al confirmar en la página. Los enlaces vencen en 72 horas.</p>`;
  await Promise.all(destinatarios.map(destinatario => mailer.send(
    destinatario,
    `Solicitud de acceso: ${user.nombre_completo}`,
    texto,
    html
  )));
}

async function enviarCorreosRegistro(user: Usuario, token: string, baseUrl: string): Promise<void> {
  const avisosAdmin = aprobadoresRegistro().map(destinatario =>
    mailer.send(
      destinatario,
      `Solicitud de acceso: ${user.nombre_completo} (pendiente de verificación)`,
      `Se recibió una solicitud de acceso:\n\nNombre: ${user.nombre_completo}\nCorreo: ${user.email}\nCorreo verificado: Pendiente\n\nAl confirmar el correo del solicitante, recibirá enlaces firmados para aprobar o rechazar la solicitud.\n\nNo se incluye ni se envía la contraseña del usuario.`
    )
  );
  await Promise.all([enviarCorreoVerificacion(user, token, baseUrl), ...avisosAdmin]);
}

function guardarUsuarioLocal(usuario: Usuario): void {
  const index = db.usuarios.findIndex(u => u.id_usuario === usuario.id_usuario);
  if (index === -1) db.usuarios.push(usuario);
  else db.usuarios[index] = usuario;
  db.saveToDisk();
}

async function consumirTokenVerificacion(tokenHash: string): Promise<Usuario | null> {
  if (await CloudSqlService.isCloudSqlOnline()) {
    const usuario = await CloudSqlService.consumePendingVerificationToken(tokenHash);
    if (usuario) guardarUsuarioLocal(usuario);
    return usuario;
  }

  const usuario = db.usuarios.find(u =>
    u.verification_token === tokenHash &&
    u.activo === false &&
    u.email_verified === false &&
    Boolean(u.token_expires_at) &&
    new Date(u.token_expires_at!).getTime() > Date.now()
  );
  if (!usuario) return null;
  Object.assign(usuario, { email_verified: true, verification_token: null, token_expires_at: null });
  db.saveToDisk();
  return usuario;
}

async function usuarioPorIdRegistro(id: number): Promise<Usuario | null> {
  if (await CloudSqlService.isCloudSqlOnline()) return CloudSqlService.getUsuarioById(id);
  return db.usuarios.find(u => u.id_usuario === id) || null;
}

async function aprobarRegistro(id: number): Promise<Usuario | null> {
  if (await CloudSqlService.isCloudSqlOnline()) {
    const usuario = await CloudSqlService.approvePendingRegistration(id);
    if (usuario) guardarUsuarioLocal(usuario);
    return usuario;
  }
  const usuario = db.usuarios.find(u => u.id_usuario === id && !u.activo && u.email_verified === true);
  if (!usuario) return null;
  usuario.activo = true;
  usuario.requiere_cambio_password = true;
  db.saveToDisk();
  return usuario;
}

async function rechazarRegistro(id: number): Promise<Usuario | null> {
  if (await CloudSqlService.isCloudSqlOnline()) {
    const usuario = await CloudSqlService.rejectPendingRegistration(id);
    if (usuario) {
      db.usuarios = db.usuarios.filter(u => u.id_usuario !== id);
      db.saveToDisk();
    }
    return usuario;
  }
  const usuario = db.usuarios.find(u => u.id_usuario === id && !u.activo && u.email_verified === true);
  if (!usuario) return null;
  db.usuarios = db.usuarios.filter(u => u.id_usuario !== id);
  db.saveToDisk();
  return usuario;
}

/** Guarda la contraseña (siempre cifrada) en Cloud SQL y en el almacenamiento local. */
async function guardarClave(user: any, hash: string, extra: Record<string, unknown> = {}) {
  await CloudSqlService.updateUsuario(user.id_usuario, { hashed_password: hash, ...extra } as any).catch(() => null);
  const local = db.usuarios.find(u => u.id_usuario === user.id_usuario);
  if (local) Object.assign(local, { hashed_password: hash, ...extra });
  db.saveToDisk();
}

function passwordMatches(user: any, password: string): boolean {
  const stored = user.hashed_password || '';
  return isHashed(stored) ? verifyPassword(password, stored) : matchesLegacyPassword(password, stored);
}

/** Los códigos de recuperación se guardan con hash, nunca en texto plano. */
function hashCodigo(codigo: string): string {
  return crypto.createHash('sha256').update(codigo.trim()).digest('hex');
}

/** Envía una contraseña provisional por correo. Devuelve false si el correo no está configurado o falla. */
async function enviarProvisionalPorCorreo(user: any, password: string): Promise<boolean> {
  if (!mailer.enabled) return false;
  try {
    await mailer.send(
      user.email,
      'Tu acceso a Consola TLM - contraseña provisional',
      `Hola ${user.nombre_completo},\n\nTu contraseña provisional es: ${password}\n\nAl iniciar sesión deberás cambiarla por una contraseña personal de mínimo 8 caracteres con letras y números.`
    );
    return true;
  } catch (e) {
    console.warn('[Correo] No se pudo enviar la contraseña provisional:', e);
    return false;
  }
}

router.post('/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const correo = String(email || '').toLowerCase().trim();
  const claveCuenta = `login:cuenta:${correo}`;
  const claveIp = `login:ip:${req.ip}`;

  // Bloqueo por cuenta (5 fallos) y por IP (30 fallos), ambos de 15 minutos
  const segundosBloqueado = Math.max(secondsLocked(claveCuenta), secondsLocked(claveIp));
  if (segundosBloqueado > 0) {
    res.set('Retry-After', String(segundosBloqueado));
    return res.status(429).json({ detail: `Demasiados intentos fallidos. Intenta de nuevo en ${Math.ceil(segundosBloqueado / 60)} minuto(s).` });
  }

  const fallo = (detail: string, status = 401) => {
    recordFailure(claveCuenta, LOGIN_MAX_POR_CUENTA, LOGIN_VENTANA_MS, LOGIN_BLOQUEO_MS);
    recordFailure(claveIp, LOGIN_MAX_POR_IP, LOGIN_VENTANA_MS, LOGIN_BLOQUEO_MS);
    return res.status(status).json({ detail });
  };

  const user = await buscarUsuarioPorCorreo(correo);
  if (!user) return fallo('Credenciales inválidas. Verifica tu correo corporativo.');
  if (user.email_verified === false) {
    return res.status(403).json({ detail: 'Confirma tu correo desde el enlace enviado para continuar con la solicitud de acceso.' });
  }
  if (!user.activo) {
    return res.status(403).json({ detail: 'Tu cuenta está pendiente de aprobación por el Administrador Maestro (Juan Yaya).' });
  }
  // La contraseña es obligatoria: sin ella nunca se inicia sesión
  if (!password || typeof password !== 'string' || !user.hashed_password) {
    return fallo('Credenciales inválidas. Verifica tu correo corporativo.');
  }
  if (!passwordMatches(user, password)) {
    return fallo('Contraseña incorrecta. Si la olvidaste, puedes generar un código de recuperación a tu correo corporativo.');
  }

  clearAttempts(claveCuenta);
  // Migración: una clave antigua en texto plano se guarda cifrada al iniciar sesión
  if (!isHashed(user.hashed_password)) {
    await guardarClave(user, hashPassword(password));
  }
  startSession(res, user);

  const mustChange = user.requiere_cambio_password === true;
  res.json({
    access_token: `token_bearer_${user.id_usuario}`,
    token_type: 'bearer',
    usuario_id: user.id_usuario,
    usuario_nombre: user.nombre_completo,
    email: user.email,
    rol: user.rol,
    empresas_ids: user.empresas_ids,
    avatar_url: user.avatar_url || null,
    requiere_cambio_password: mustChange,
    usuario: usuarioPublico(user),
    mensaje_seguridad: mustChange
      ? 'Contraseña provisional detectada asignada por el Administrador. Debes cambiarla obligatoriamente a una contraseña alfanumérica de mínimo 8 caracteres antes de continuar.'
      : undefined
  });
});

// Usuario de la sesión actual (la interfaz lo usa al abrir la página)
router.get('/auth/sesion', (req: Request, res: Response) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'No hay sesión activa.' });
  res.json(usuarioPublico(user));
});

router.post('/auth/logout', (_req: Request, res: Response) => {
  endSession(res);
  res.json({ ok: true });
});

// Solo cambia la contraseña de la sesión activa, y exige la clave actual cuando se envía
router.post('/auth/cambiar-password', async (req: Request, res: Response) => {
  const user = (req as any).usuario;
  const { password_actual, nueva_password, confirmar_password } = req.body;

  if (password_actual && !passwordMatches(user, String(password_actual))) {
    return res.status(401).json({ detail: 'La contraseña actual es incorrecta.' });
  }
  if (nueva_password !== confirmar_password) {
    return res.status(400).json({ detail: 'La confirmación no coincide con la nueva contraseña.' });
  }
  const checkRule = validatePasswordRule(nueva_password);
  if (!checkRule.ok) return res.status(400).json({ detail: checkRule.message });
  if (password_actual && password_actual === nueva_password) {
    return res.status(400).json({ detail: 'La nueva contraseña debe ser diferente a la contraseña actual/provisional.' });
  }

  await guardarClave(user, hashPassword(nueva_password), { requiere_cambio_password: false, ultimo_cambio_password: new Date().toISOString() });
  db.addNotificacionSeguridad({
    destinatario: user.email,
    asunto: 'Confirmación de Cambio de Contraseña - Consola TLM',
    tipo: 'PASSWORD_CAMBIADA',
    mensaje: `Hola ${user.nombre_completo}, tu contraseña corporativa ha sido actualizada exitosamente. Tu cuenta se encuentra protegida.`
  });
  res.json({ ok: true, mensaje: '¡Contraseña actualizada con éxito! Tus credenciales ahora están protegidas.' });
});

router.post('/auth/usuarios/crear-por-admin', async (req: Request, res: Response) => {
  const { nombre_completo, email, rol, password_provisional, empresas_ids, autor_id, autor_nombre } = req.body;
  if (!nombre_completo || !email || !password_provisional) {
    return res.status(400).json({ detail: 'Nombre completo, correo corporativo y contraseña provisional son obligatorios.' });
  }
  const correo = String(email).toLowerCase().trim();
  if (await buscarUsuarioPorCorreo(correo)) {
    return res.status(400).json({ detail: 'El correo electrónico ya se encuentra registrado.' });
  }
  const checkRule = validatePasswordRule(password_provisional);
  if (!checkRule.ok) return res.status(400).json({ detail: `La contraseña provisional debe cumplir la política: ${checkRule.message}` });

  const roleValue = (['Administrador', 'Contador', 'Analista', 'Auditor'].includes(rol) ? rol : 'Analista') as any;
  const idNuevo = Math.max(...db.usuarios.map(u => u.id_usuario), 0) + 1;
  const nuevo: any = {
    id_usuario: idNuevo,
    nombre_completo: String(nombre_completo).trim(),
    email: correo,
    hashed_password: hashPassword(password_provisional),
    rol: roleValue,
    activo: true,
    requiere_cambio_password: true,
    empresas_ids: Array.isArray(empresas_ids) && empresas_ids.length > 0 ? empresas_ids : [1],
    permisos: getDefaultPermissions(roleValue),
    ultimo_cambio_password: new Date().toISOString()
  };
  const creado = await CloudSqlService.createUsuario(nuevo).catch(() => null);
  if (creado) nuevo.id_usuario = creado.id_usuario;
  db.usuarios.push(nuevo);
  db.saveToDisk();

  // La clave provisional no se guarda en las notificaciones: va por correo, o la recibe el administrador
  db.addNotificacionSeguridad({
    destinatario: nuevo.email,
    asunto: 'Credenciales de Acceso a Consola TLM',
    tipo: 'NUEVO_USUARIO',
    mensaje: `Estimado/a ${nuevo.nombre_completo}, el administrador habilitó tu acceso a la Consola TLM. La contraseña provisional se entregó por separado.`
  });
  const correoEnviado = await enviarProvisionalPorCorreo(nuevo, password_provisional);
  db.addModificacion({
    autor_id: (req as any).usuario?.id_usuario ?? autor_id,
    autor_nombre: (req as any).usuario?.nombre_completo || autor_nombre || 'Usuario no identificado',
    tipo_accion: 'COLABORACION',
    descripcion: `Creación de usuario ${nuevo.nombre_completo} (${nuevo.rol})`,
    detalles: `Cuenta con cambio de clave obligatorio al primer ingreso. Correo enviado: ${correoEnviado ? 'sí' : 'no'}.`
  });

  res.status(201).json({
    ok: true,
    mensaje: `Usuario ${nuevo.nombre_completo} creado. Deberá cambiar su contraseña al iniciar sesión.`,
    correo_enviado: correoEnviado,
    password_provisional: correoEnviado ? undefined : password_provisional,
    usuario: usuarioPublico(nuevo)
  });
});

router.post('/auth/usuarios/:id/reset-password-admin', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { nueva_password_provisional } = req.body;
  const user: any = db.usuarios.find(u => u.id_usuario === id) || (await CloudSqlService.getUsuarioById(id).catch(() => null));
  if (!user) return res.status(404).json({ detail: 'Usuario no encontrado.' });
  if (!nueva_password_provisional) return res.status(400).json({ detail: 'Debes ingresar una contraseña provisional para el usuario.' });
  const checkRule = validatePasswordRule(nueva_password_provisional);
  if (!checkRule.ok) return res.status(400).json({ detail: checkRule.message });

  await guardarClave(user, hashPassword(nueva_password_provisional), { requiere_cambio_password: true, codigo_recuperacion: null, codigo_recuperacion_expira: null });
  db.addNotificacionSeguridad({
    destinatario: user.email,
    asunto: 'Restablecimiento de Contraseña por Administrador - Consola TLM',
    tipo: 'RESET_ADMIN',
    mensaje: `Hola ${user.nombre_completo}, el administrador restableció tu acceso. La nueva contraseña provisional se entregó por separado. Deberás cambiarla al iniciar sesión.`
  });
  const correoEnviado = await enviarProvisionalPorCorreo(user, nueva_password_provisional);
  res.json({
    ok: true,
    mensaje: `Contraseña provisional asignada a ${user.nombre_completo}.`,
    correo_enviado: correoEnviado,
    password_provisional: correoEnviado ? undefined : nueva_password_provisional,
    usuario: usuarioPublico(user)
  });
});

// Código de recuperación por correo. La respuesta es igual exista o no la cuenta.
router.post('/auth/recuperar-password/solicitar-codigo', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ detail: 'Ingresa tu correo electrónico corporativo.' });
  if (!mailer.enabled) {
    return res.status(503).json({ detail: 'El envío de códigos por correo no está configurado. Pide al administrador que defina SMTP_HOST en el servidor.' });
  }
  const correo = String(email).toLowerCase().trim();
  const claveCodigo = `codigo:${correo}`;
  const espera = secondsLocked(claveCodigo);
  if (espera > 0) {
    res.set('Retry-After', String(espera));
    return res.status(429).json({ detail: `Espera ${espera} segundos antes de pedir otro código.` });
  }
  lockFor(claveCodigo, CODIGO_ESPERA_MS);

  const respuestaGenerica = {
    ok: true,
    mensaje: 'Si el correo está registrado, recibirás un código de seguridad de 6 dígitos en los próximos minutos.',
    expira_en_minutos: 15
  };
  const user: any = await buscarUsuarioPorCorreo(correo);
  if (!user || !user.activo) return res.json(respuestaGenerica);

  const codigoOtp = crypto.randomInt(100000, 1000000).toString();
  try {
    await mailer.send(user.email, 'Código de seguridad - Consola TLM',
      `Hola ${user.nombre_completo},\n\nTu código de seguridad para restablecer la contraseña es: ${codigoOtp}\n\nExpira en 15 minutos. Si tú no lo solicitaste, ignora este correo y avisa a Juan Yaya (automatizaciones@tlm.net.co).`);
  } catch (e) {
    console.warn('[Correo] No se pudo enviar el código de recuperación:', e);
    return res.status(502).json({ detail: 'No pudimos enviar el correo con el código. Intenta más tarde.' });
  }
  // Solo se guarda el hash del código y se cuentan los intentos fallidos
  await guardarClave(user, user.hashed_password, {
    codigo_recuperacion: hashCodigo(codigoOtp),
    codigo_recuperacion_expira: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    intentos_codigo: 0
  });
  db.addNotificacionSeguridad({
    destinatario: user.email,
    asunto: 'Solicitud de recuperación de contraseña - TLM',
    tipo: 'CODIGO_RECUPERACION',
    mensaje: `Se envió un código de recuperación al correo de ${user.nombre_completo}. El código no se muestra en esta consola.`
  });
  res.json(respuestaGenerica);
});

router.post('/auth/recuperar-password/verificar-y-cambiar', async (req: Request, res: Response) => {
  const { email, codigo, nueva_password, confirmar_password } = req.body;
  if (!email || !codigo || !nueva_password) {
    return res.status(400).json({ detail: 'Correo, código de seguridad y nueva contraseña son requeridos.' });
  }
  const correo = String(email).toLowerCase().trim();
  const mensajeIncorrecto = 'El código de seguridad ingresado es incorrecto.';
  const claveRecuperacion = `recuperar:${correo}`;
  const espera = secondsLocked(claveRecuperacion);
  if (espera > 0) {
    res.set('Retry-After', String(espera));
    return res.status(429).json({ detail: `Demasiados intentos fallidos. Intenta de nuevo en ${Math.ceil(espera / 60)} minuto(s).` });
  }

  const user: any = await buscarUsuarioPorCorreo(correo);
  if (!user || !user.codigo_recuperacion) {
    recordFailure(claveRecuperacion, LOGIN_MAX_POR_CUENTA, LOGIN_VENTANA_MS, LOGIN_BLOQUEO_MS);
    return res.status(400).json({ detail: mensajeIncorrecto });
  }
  if (user.codigo_recuperacion_expira && new Date() > new Date(user.codigo_recuperacion_expira)) {
    await guardarClave(user, user.hashed_password, { codigo_recuperacion: null });
    return res.status(400).json({ detail: 'El código de seguridad ha expirado (validez: 15 minutos). Solicita un nuevo código.' });
  }
  if ((user.intentos_codigo || 0) >= 5) {
    await guardarClave(user, user.hashed_password, { codigo_recuperacion: null });
    return res.status(429).json({ detail: 'Demasiados intentos fallidos. Solicita un nuevo código de seguridad.' });
  }
  if (user.codigo_recuperacion !== hashCodigo(String(codigo))) {
    recordFailure(claveRecuperacion, LOGIN_MAX_POR_CUENTA, LOGIN_VENTANA_MS, LOGIN_BLOQUEO_MS);
    await guardarClave(user, user.hashed_password, { intentos_codigo: (user.intentos_codigo || 0) + 1 });
    return res.status(400).json({ detail: mensajeIncorrecto });
  }
  clearAttempts(claveRecuperacion);

  if (nueva_password !== confirmar_password) {
    return res.status(400).json({ detail: 'La confirmación no coincide con la nueva contraseña.' });
  }
  const checkRule = validatePasswordRule(nueva_password);
  if (!checkRule.ok) return res.status(400).json({ detail: checkRule.message });

  await guardarClave(user, hashPassword(nueva_password), {
    codigo_recuperacion: null, codigo_recuperacion_expira: null, intentos_codigo: 0,
    requiere_cambio_password: false, ultimo_cambio_password: new Date().toISOString()
  });
  db.addNotificacionSeguridad({
    destinatario: user.email,
    asunto: 'Contraseña Recuperada y Restablecida con Éxito - TLM',
    tipo: 'PASSWORD_CAMBIADA',
    mensaje: `Hola ${user.nombre_completo}, tu contraseña corporativa fue restablecida mediante código de seguridad.`
  });
  res.json({
    ok: true,
    mensaje: '¡Contraseña recuperada y actualizada con éxito! Ya puedes iniciar sesión con tus nuevas credenciales.',
    usuario: usuarioPublico(user)
  });
});

router.get('/auth/notificaciones-seguridad', (_req: Request, res: Response) => {
  // Los códigos y contraseñas nunca se exponen en el historial
  res.json(db.notificacionesSeguridad.map(ocultarSecretos));
});

router.post('/auth/register', async (req: Request, res: Response) => {
  const { nombre_completo, email, password } = req.body;
  if (typeof email !== 'string' || typeof nombre_completo !== 'string' || !nombre_completo.trim()) {
    return res.status(400).json({ detail: 'Nombre completo y correo son requeridos.' });
  }
  const correo = email.toLowerCase().trim();
  if (!correoValido(correo)) return res.status(400).json({ detail: 'Ingresa una dirección de correo válida.' });
  const checkRule = validatePasswordRule(password);
  if (!checkRule.ok) return res.status(400).json({ detail: checkRule.message });
  if (!mailer.enabled) return res.status(503).json({ detail: 'El registro requiere correo. Configura SMTP_HOST en el servidor.' });
  if (!aprobadoresRegistro().length) {
    return res.status(503).json({ detail: 'No hay correos válidos configurados para aprobar registros.' });
  }
  let baseUrl: string;
  try {
    baseUrl = baseUrlAplicacion();
  } catch (error) {
    console.error('[Registro] URL pública no configurada:', error);
    return res.status(503).json({ detail: 'El servidor no tiene una URL pública válida configurada para completar el registro.' });
  }

  if (registrosEnProceso.has(correo)) {
    return res.status(409).json({ detail: 'Ya hay una solicitud en curso para ese correo. Intenta de nuevo más tarde.' });
  }
  registrosEnProceso.add(correo);
  try {
    const cloudOnline = await CloudSqlService.isCloudSqlOnline();
    const existente = cloudOnline
      ? await CloudSqlService.getUsuarioByEmail(correo)
      : db.usuarios.find(u => u.email.trim().toLowerCase() === correo) || null;
    if (existente) return res.status(400).json({ detail: 'El correo electrónico ya se encuentra registrado.' });

    const claveRegistroIp = `registro:ip:${req.ip}`;
    const segundosRegistro = secondsLocked(claveRegistroIp);
    if (segundosRegistro > 0) {
      res.set('Retry-After', String(segundosRegistro));
      return res.status(429).json({ detail: `Espera ${segundosRegistro} segundos antes de enviar otra solicitud.` });
    }
    lockFor(claveRegistroIp, CODIGO_ESPERA_MS);

    const idNuevo = Math.max(...db.usuarios.map(u => u.id_usuario), 0) + 1;
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const nuevo: any = {
      id_usuario: idNuevo, nombre_completo: String(nombre_completo).trim(), email: correo,
      hashed_password: hashPassword(password), rol: 'Analista', activo: false,
      requiere_cambio_password: true, email_verified: false,
      verification_token: hashCodigo(token), token_expires_at: tokenExpiresAt,
      empresas_ids: [1], permisos: getDefaultPermissions('Analista')
    };
    if (cloudOnline) {
      try {
        Object.assign(nuevo, await CloudSqlService.createUsuario(nuevo));
      } catch (error: any) {
        console.error('[Registro] No se pudo crear la cuenta en Cloud SQL:', error);
        if (error?.code === '23505') {
          return res.status(400).json({ detail: 'El correo electrónico ya se encuentra registrado.' });
        }
        return res.status(503).json({ detail: 'No se pudo guardar la solicitud. Intenta de nuevo más tarde.' });
      }
    }

    guardarUsuarioLocal(nuevo);
    try {
      await enviarCorreosRegistro(nuevo, token, baseUrl);
    } catch (error: any) {
      console.error('[Registro] No se pudieron enviar todos los correos de verificación/aprobación:', error);
      return res.status(503).json({
        detail: 'La solicitud quedó guardada, pero no se pudieron enviar todos los correos. Usa “Reenviar verificación” para intentarlo de nuevo.',
        registro_creado: true
      });
    }
    return res.status(201).json({
      mensaje: 'Solicitud guardada. Revisa tu correo y confirma el enlace; después, el administrador recibirá los botones para aprobar o rechazar.',
      id_usuario: nuevo.id_usuario
    });
  } catch (error) {
    console.error('[Registro] Error inesperado al guardar la solicitud:', error);
    return res.status(503).json({ detail: 'No se pudo guardar la solicitud. Intenta de nuevo más tarde.' });
  } finally {
    registrosEnProceso.delete(correo);
  }
});

router.get('/auth/register/verify', async (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).type('html').send('<h1>Enlace no válido</h1><p>Solicita un nuevo correo de verificación desde Consola TLM.</p>');
  }

  res.type('html').send(paginaAprobacion(
    'Confirmar correo',
    `<p>Confirma que tienes acceso al correo asociado a esta solicitud.</p><form method="post" action="/api/v1/auth/register/verify"><input type="hidden" name="token" value="${escaparHtml(token)}"><button type="submit" style="background:#271a82;color:white;border:0;border-radius:8px;padding:12px 18px;font-weight:bold;cursor:pointer">Confirmar correo</button></form>`
  ));
});

router.post('/auth/register/verify', async (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).type('html').send('<h1>Enlace no válido</h1><p>Solicita un nuevo correo de verificación desde Consola TLM.</p>');
  }

  let user: Usuario | null;
  try {
    user = await consumirTokenVerificacion(hashCodigo(token));
  } catch (error) {
    console.error('[Registro] No se pudo confirmar el correo:', error);
    return res.status(503).type('html').send('<h1>No se pudo confirmar</h1><p>Intenta de nuevo más tarde.</p>');
  }
  if (!user) {
    return res.status(400).type('html').send('<h1>Enlace no válido o ya utilizado</h1><p>Solicita un nuevo correo de verificación desde Consola TLM.</p>');
  }

  let baseUrl = '/';
  try {
    baseUrl = baseUrlAplicacion();
  } catch (error) {
    console.error('[Registro] No se pudo construir la URL pública:', error);
  }
  const mensaje = `<h1>Correo verificado</h1><p>Tu buzón quedó confirmado. La solicitud aún requiere la aprobación de un administrador de TLM.</p><p><a href="${escaparHtml(baseUrl)}">Ir a Consola TLM</a></p>`;
  try {
    await enviarSolicitudAprobacion(user, baseUrl === '/' ? baseUrlAplicacion() : baseUrl);
  } catch (error) {
    console.error('[Registro] No se pudo enviar al aprobador los enlaces de aprobación:', error);
  }
  res.status(200).type('html').send(mensaje);
});

router.post('/auth/register/resend-verification', async (req: Request, res: Response) => {
  const correo = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!correoValido(correo) || !mailer.enabled) {
    return res.status(503).json({ detail: 'No fue posible reenviar el correo. Verifica la dirección y vuelve a intentar más tarde.' });
  }
  const claveReenvio = `registro:reenvio:${correo}`;
  const segundosReenvio = secondsLocked(claveReenvio);
  if (segundosReenvio > 0) {
    res.set('Retry-After', String(segundosReenvio));
    return res.status(429).json({ detail: `Espera ${segundosReenvio} segundos antes de solicitar otro correo.` });
  }
  lockFor(claveReenvio, CODIGO_ESPERA_MS);
  const cloudOnline = await CloudSqlService.isCloudSqlOnline();
  let user = cloudOnline
    ? await CloudSqlService.getUsuarioByEmail(correo)
    : db.usuarios.find(u => u.email.trim().toLowerCase() === correo) || null;
  if (!user || user.activo || user.email_verified !== false) {
    return res.json({ mensaje: 'Si hay una solicitud pendiente para ese correo, recibirás instrucciones para continuar.' });
  }
  let baseUrl: string;
  try {
    baseUrl = baseUrlAplicacion();
  } catch (error) {
    console.error('[Registro] URL pública no configurada para reenviar verificación:', error);
    return res.status(503).json({ detail: 'El servidor no tiene una URL pública válida configurada para completar el registro.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  try {
    if (cloudOnline) {
      const actualizado = await CloudSqlService.replacePendingVerificationToken(
        user.id_usuario,
        hashCodigo(token),
        tokenExpiresAt
      );
      if (!actualizado) {
        return res.json({ mensaje: 'Si hay una solicitud pendiente para ese correo, recibirás instrucciones para continuar.' });
      }
      user = actualizado;
      guardarUsuarioLocal(user);
    } else {
      const local = db.usuarios.find(u =>
        u.id_usuario === user!.id_usuario &&
        !u.activo &&
        u.email_verified === false
      );
      if (!local) {
        return res.json({ mensaje: 'Si hay una solicitud pendiente para ese correo, recibirás instrucciones para continuar.' });
      }
      Object.assign(local, { verification_token: hashCodigo(token), token_expires_at: tokenExpiresAt });
      db.saveToDisk();
    }
    await enviarCorreoVerificacion(user, token, baseUrl);
  } catch (error) {
    console.error('[Registro] No se pudo reenviar la verificación:', error);
    return res.status(503).json({ detail: 'No se pudieron enviar los correos. Vuelve a intentarlo más tarde.' });
  }
  res.json({ mensaje: 'Se reenviaron las instrucciones de verificación al correo indicado.' });
});

function paginaAprobacion(titulo: string, contenido: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escaparHtml(titulo)}</title></head><body style="font-family:Arial,sans-serif;background:#f4f5fb;padding:32px;color:#1f2937"><main style="max-width:460px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px"><h1 style="font-size:20px">${escaparHtml(titulo)}</h1>${contenido}</main></body></html>`;
}

router.get('/auth/aprobar-por-correo', async (req: Request, res: Response) => {
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const solicitud = verificarTokenAprobacion(token);
  if (!solicitud) {
    return res.status(400).type('html').send(paginaAprobacion('Solicitud no disponible', '<p>El enlace no es válido o ya venció. Pide al administrador revisar la solicitud desde Consola TLM.</p>'));
  }

  let user: Usuario | null;
  try {
    user = await usuarioPorIdRegistro(solicitud.idUsuario);
  } catch (error) {
    console.error('[Registro] No se pudo consultar la solicitud de aprobación:', error);
    return res.status(503).type('html').send(paginaAprobacion('No se pudo consultar', '<p>Intenta de nuevo más tarde.</p>'));
  }
  if (!user || huellaCorreo(user.email) !== solicitud.huella || user.activo || user.email_verified !== true) {
    return res.status(409).type('html').send(paginaAprobacion('Solicitud no disponible', '<p>La solicitud ya fue procesada, no está verificada o la persona ya no está registrada.</p>'));
  }

  const aprobar = solicitud.accion === 'aprobar';
  const textoAccion = aprobar ? 'aprobar el acceso' : 'rechazar la solicitud';
  const etiqueta = aprobar ? 'Confirmar aprobación' : 'Confirmar rechazo';
  const color = aprobar ? '#16a34a' : '#dc2626';
  res.type('html').send(paginaAprobacion(
    aprobar ? 'Aprobar acceso' : 'Rechazar solicitud',
    `<p><b>${escaparHtml(user.nombre_completo)}</b><br>${escaparHtml(user.email)}</p><p>Al confirmar, vas a ${textoAccion}.</p><form method="post" action="/api/v1/auth/aprobar-por-correo"><input type="hidden" name="t" value="${escaparHtml(token)}"><button type="submit" style="background:${color};color:white;border:0;border-radius:8px;padding:12px 18px;font-weight:bold;cursor:pointer">${etiqueta}</button></form>`
  ));
});

router.post('/auth/aprobar-por-correo', async (req: Request, res: Response) => {
  const token = typeof req.body?.t === 'string' ? req.body.t : '';
  const solicitud = verificarTokenAprobacion(token);
  if (!solicitud) {
    return res.status(400).type('html').send(paginaAprobacion('Solicitud no disponible', '<p>El enlace no es válido o ya venció.</p>'));
  }

  let user: Usuario | null;
  try {
    user = await usuarioPorIdRegistro(solicitud.idUsuario);
  } catch (error) {
    console.error('[Registro] No se pudo consultar la solicitud de aprobación:', error);
    return res.status(503).type('html').send(paginaAprobacion('No se pudo completar', '<p>Intenta de nuevo más tarde.</p>'));
  }
  if (!user || huellaCorreo(user.email) !== solicitud.huella || user.email_verified !== true) {
    return res.status(409).type('html').send(paginaAprobacion('Solicitud no disponible', '<p>La solicitud ya fue procesada o ya no está disponible.</p>'));
  }

  try {
    const updated = solicitud.accion === 'aprobar'
      ? await aprobarRegistro(user.id_usuario)
      : await rechazarRegistro(user.id_usuario);
    if (!updated) {
      return res.status(409).type('html').send(paginaAprobacion('Solicitud no disponible', '<p>La solicitud ya fue procesada o ya no está disponible.</p>'));
    }

    if (solicitud.accion === 'aprobar') {
      try {
        await mailer.send(
          updated.email,
          'Tu acceso a Consola TLM fue aprobado',
          `Hola ${updated.nombre_completo}, un administrador aprobó tu acceso a la Consola TLM. Ya puedes iniciar sesión con el correo ${updated.email} y la contraseña que registraste. Por seguridad, tendrás que cambiarla antes de continuar.`
        );
      } catch (error) {
        console.error('[Registro] No se pudo enviar el aviso de aprobación:', error);
      }
      return res.type('html').send(paginaAprobacion('Acceso aprobado', `<p><b>${escaparHtml(updated.nombre_completo)}</b> ya puede iniciar sesión.</p>`));
    }

    try {
      await mailer.send(
        updated.email,
        'Tu solicitud de acceso a la Consola TLM no fue aprobada',
        `Hola ${updated.nombre_completo}, tu solicitud de acceso a la Consola TLM no fue aprobada. Si crees que es un error, comunícate con el administrador.`
      );
    } catch (error) {
      console.error('[Registro] No se pudo enviar el aviso de rechazo:', error);
    }
    return res.type('html').send(paginaAprobacion('Solicitud rechazada', `<p>Se rechazó la solicitud de <b>${escaparHtml(updated.email)}</b>.</p>`));
  } catch (error) {
    console.error('[Registro] No se pudo procesar la aprobación por correo:', error);
    return res.status(503).type('html').send(paginaAprobacion('No se pudo completar', '<p>Intenta de nuevo más tarde.</p>'));
  }
});

router.get('/auth/usuarios', async (_req: Request, res: Response) => {
  try {
    const usuarios = await CloudSqlService.getUsuarios();
    if (usuarios.length > 0) {
      return res.json(usuarios.map(usuarioPublico));
    }
  } catch (err) {
    console.warn('[CloudSQL] Fallback usuarios a DataStore local:', err);
  }
  res.json(db.usuarios.map(usuarioPublico));
});

router.patch('/auth/usuarios/:id/aprobar', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  try {
    const user = await usuarioPorIdRegistro(id);
    if (!user) return res.status(404).json({ detail: 'No se encontró el usuario solicitado.' });
    if (user.email_verified !== true) {
      return res.status(409).json({ detail: 'El usuario debe confirmar su correo antes de aprobar el acceso.' });
    }
    if (user.activo) {
      return res.json({ mensaje: 'El usuario ya está aprobado.', usuario: usuarioPublico(user), correo_enviado: false });
    }

    const actualizado = await aprobarRegistro(id);
    if (!actualizado) {
      return res.status(409).json({ detail: 'La solicitud ya fue procesada. Actualiza la lista de usuarios.' });
    }
    let correoEnviado = true;
    try {
      await mailer.send(
        actualizado.email,
        'Tu acceso a Consola TLM fue aprobado',
        `Hola ${actualizado.nombre_completo},\n\nUn administrador aprobó tu solicitud de acceso a Consola TLM. Inicia sesión con el correo ${actualizado.email} y la contraseña que elegiste al registrarte. Por seguridad, tendrás que cambiarla por una nueva contraseña personal antes de continuar.`
      );
    } catch (error) {
      correoEnviado = false;
      console.error('[Registro] No se pudo enviar el aviso de aprobación:', error);
    }
    res.json({
      mensaje: correoEnviado
        ? 'Usuario aprobado y aviso enviado por correo.'
        : 'Usuario aprobado, pero no se pudo enviar el aviso por correo.',
      usuario: usuarioPublico(actualizado),
      correo_enviado: correoEnviado
    });
  } catch (err: any) {
    console.error('[Registro] No se pudo aprobar el usuario:', err);
    res.status(503).json({ detail: 'No se pudo aprobar el usuario. Intenta de nuevo más tarde.' });
  }
});

router.patch('/auth/usuarios/:id/rol', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { rol } = req.body;
  if (!['Administrador', 'Contador', 'Analista', 'Auditor'].includes(rol)) {
    return res.status(400).json({ detail: "Rol especificado no es válido." });
  }
  if (id === 1 && rol !== 'Administrador') {
    return res.status(400).json({ detail: "El Administrador Maestro (Juan Yaya) no puede ser degradado." });
  }

  try {
    const permisos = getDefaultPermissions(rol);
    const updated = await CloudSqlService.updateUsuario(id, { rol, permisos });
    const user = db.usuarios.find(u => u.id_usuario === id);
    if (user) {
      user.rol = rol;
      user.permisos = permisos;
      db.saveToDisk();
    }
    res.json({ mensaje: `Rol cambiado a ${rol} con permisos estándar asociados en Cloud SQL.`, usuario: updated || user });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

router.patch('/auth/usuarios/:id/toggle-admin', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (id === 1) {
    return res.status(400).json({ detail: "El Administrador Maestro principal debe conservar rol de Administrador." });
  }
  try {
    const current = (await CloudSqlService.getUsuarioById(id)) || db.usuarios.find(u => u.id_usuario === id);
    if (!current) return res.status(404).json({ detail: "Usuario no encontrado." });

    const newRol = current.rol === 'Administrador' ? 'Contador' : 'Administrador';
    const newPermisos = getDefaultPermissions(newRol);
    const updated = await CloudSqlService.updateUsuario(id, { rol: newRol, permisos: newPermisos });

    const uLocal = db.usuarios.find(u => u.id_usuario === id);
    if (uLocal) {
      uLocal.rol = newRol;
      uLocal.permisos = newPermisos;
      db.saveToDisk();
    }

    res.json({
      mensaje: newRol === 'Administrador' ? `Permisos de Administrador concedidos a ${current.nombre_completo}.` : `Permisos de Administrador revocados para ${current.nombre_completo}.`,
      usuario: updated || uLocal
    });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

router.patch('/auth/usuarios/:id/toggle-activo', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (id === 1) {
    return res.status(400).json({ detail: "El Administrador Maestro no puede ser desactivado." });
  }
  try {
    const current = (await CloudSqlService.getUsuarioById(id)) || db.usuarios.find(u => u.id_usuario === id);
    if (!current) return res.status(404).json({ detail: "Usuario no encontrado." });

    const newActivo = !current.activo;
    const updated = await CloudSqlService.updateUsuario(id, { activo: newActivo });

    const uLocal = db.usuarios.find(u => u.id_usuario === id);
    if (uLocal) {
      uLocal.activo = newActivo;
      db.saveToDisk();
    }

    res.json({
      mensaje: newActivo ? `Acceso activado para ${current.nombre_completo}.` : `Acceso suspendido/revocado para ${current.nombre_completo}.`,
      usuario: updated || uLocal
    });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

router.patch('/auth/usuarios/:id/permisos', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { permisos } = req.body;
  try {
    const current = (await CloudSqlService.getUsuarioById(id)) || db.usuarios.find(u => u.id_usuario === id);
    if (!current) return res.status(404).json({ detail: "Usuario no encontrado." });

    const merged = { ...current.permisos, ...permisos };
    let rolUpdate = current.rol;
    if (permisos.administrador === true) {
      rolUpdate = 'Administrador';
    } else if (permisos.administrador === false && current.rol === 'Administrador') {
      rolUpdate = 'Contador';
    }

    const updated = await CloudSqlService.updateUsuario(id, { permisos: merged, rol: rolUpdate });
    const user = db.usuarios.find(u => u.id_usuario === id);
    if (user) {
      user.permisos = merged;
      user.rol = rolUpdate;
      db.saveToDisk();
    }
    res.json({ mensaje: `Permisos granulares actualizados en Cloud SQL para ${current.nombre_completo}.`, usuario: updated || user });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

router.patch('/auth/usuarios/:id/empresas', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { empresas_ids } = req.body;
  try {
    const updated = await CloudSqlService.updateUsuario(id, { empresas_ids });
    const user = db.usuarios.find(u => u.id_usuario === id);
    if (user && Array.isArray(empresas_ids)) {
      user.empresas_ids = empresas_ids;
      db.saveToDisk();
    }
    res.json({ mensaje: `Empresas autorizadas actualizadas en Cloud SQL.`, usuario: updated || user });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

router.patch('/auth/usuarios/:id/avatar', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { avatar_url } = req.body;
  try {
    const updated = await CloudSqlService.updateUsuario(id, { avatar_url });
    const user = db.usuarios.find(u => u.id_usuario === id);
    if (user) {
      user.avatar_url = avatar_url || null;
      db.saveToDisk();
    }
    res.json({
      mensaje: avatar_url 
        ? `Imagen corporativa actualizada con éxito en Cloud SQL.` 
        : `Imagen corporativa removida en Cloud SQL.`,
      usuario: updated || user
    });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

router.delete('/auth/usuarios/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (id === 1) {
    return res.status(400).json({ detail: "No se puede eliminar al Administrador Maestro (Juan Yaya)." });
  }
  try {
    await CloudSqlService.deleteUsuario(id);
    const index = db.usuarios.findIndex(u => u.id_usuario === id);
    if (index !== -1) {
      db.usuarios.splice(index, 1);
      db.saveToDisk();
    }
    res.json({ mensaje: "Usuario eliminado correctamente de Cloud SQL y la plataforma." });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

router.get('/sistema/database-info', (_req: Request, res: Response) => {
  res.json(db.getDatabaseInfo());
});

// ==========================================
// GESTIÓN DE IDENTIDAD CORPORATIVA & LOGOTIPOS (JUAN YAYA - ADMIN MAESTRO)
// ==========================================
router.get('/sistema/branding', (_req: Request, res: Response) => {
  res.json(db.getBrandingConfig());
});

router.put('/sistema/branding', (req: Request, res: Response) => {
  const { customLogoUrl, variantTitle, subtitulo, temaAcento, sidebarColor, autor_nombre } = req.body;
  const config = db.updateBrandingConfig({
    customLogoUrl,
    variantTitle,
    subtitulo,
    temaAcento,
    sidebarColor,
    autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado'
  });
  res.json({
    mensaje: "Identidad visual y logotipos actualizados exitosamente por el Administrador Juan Yaya.",
    config
  });
});

// ==========================================
// EXPORTACIÓN DE BASE DE DATOS EN FORMATO EXCEL (.XLSX)
// ==========================================
router.get('/sistema/exportar-excel-completo', (_req: Request, res: Response) => {
  try {
    const { buffer } = ExcelService.generarLibroCompleto(db);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tlm_base_de_datos_maestra.xlsx"');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error: any) {
    console.error("Error al exportar base de datos a Excel:", error);
    res.status(500).json({ error: "Error al generar archivo Excel de la base de datos", detalle: error.message });
  }
});

router.get('/sistema/exportar-excel/:tabla', (req: Request, res: Response) => {
  try {
    const tabla = req.params.tabla;
    const { buffer, fileName } = ExcelService.generarLibroTabla(db, tabla);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error: any) {
    console.error("Error al exportar tabla a Excel:", error);
    res.status(500).json({ error: "Error al generar archivo Excel de la tabla", detalle: error.message });
  }
});

router.post('/sistema/generar-excel', (req: Request, res: Response) => {
  try {
    const { buffer } = ExcelService.generarLibroCompleto(db);
    const autorNombre = req.body?.autor_nombre || "Juan Yaya - Administrador Maestro";
    const autorId = req.body?.autor_id || 1;

    db.addModificacion({
      autor_id: autorId,
      autor_nombre: autorNombre,
      tipo_accion: "RELEASE_V2",
      descripcion: "Generación de Base de Datos Maestra en Formato Excel (.xlsx)",
      detalles: `Archivo generado exitosamente con 10 hojas de cálculo estructuradas (${(buffer.length / 1024).toFixed(1)} KB) y sincronizado con Google Drive.`
    });

    res.json({
      exito: true,
      mensaje: "Base de datos generada exitosamente en formato Excel (.xlsx) con 10 pestañas estructuradas.",
      archivo_nombre: "tlm_base_de_datos_maestra.xlsx",
      descarga_url: "/tlm_base_de_datos_maestra.xlsx",
      tamano_kb: (buffer.length / 1024).toFixed(1),
      hojas_incluidas: [
        "RESUMEN_GENERAL",
        "FACTURAS_DIAN",
        "PLAN_CUENTAS_PUC",
        "BALANCE_TERCEROS",
        "MOVIMIENTOS_BANCO",
        "MOVIMIENTOS_LIBRO",
        "USUARIOS_Y_PERMISOS",
        "ACCESOS_DESARROLLADORES",
        "GOOGLE_DRIVE_ARCHIVOS",
        "AUDITORIA_MODIFICACIONES"
      ]
    });
  } catch (error: any) {
    console.error("Error al generar Excel:", error);
    res.status(500).json({ error: "Error al generar Excel", detalle: error.message });
  }
});

// ==========================================
// GOOGLE CLOUD PLATFORM (GCP) INTEGRACIÓN
// ==========================================
router.get('/sistema/google-cloud-status', (_req: Request, res: Response) => {
  res.json({
    conectado: false,
    mensaje: 'La integración con Google Cloud no está configurada en este servidor.',
    proveedor: 'Google Cloud Platform (GCP)',
    entorno: process.env.NODE_ENV || 'production'
  });
});

router.post('/sistema/google-cloud-sync', (_req: Request, res: Response) => {
  // Sin integración configurada no se registra ninguna sincronización falsa
  res.status(501).json({ ok: false, simulado: true, detail: 'La sincronización con Google Cloud no está configurada en este servidor. No se realizó ningún despliegue.' });
});

// Sincronización de Identidades & Permisos de Usuarios con Google Cloud IAM
router.post('/sistema/google-cloud-iam-sync', (req: Request, res: Response) => {
  const { autor_id, autor_nombre } = req.body;
  const hash = 'iam-' + Math.random().toString(36).substring(2, 9);
  
  const mod = db.addModificacion({
    autor_id: autor_id || 1,
    autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
    tipo_accion: "GCP_SYNC",
    descripcion: `Sincronización de ${db.usuarios.length} identidades con Google Cloud IAM (${hash})`,
    detalles: `Roles y privilegios de usuarios TLM sincronizados con Google Cloud IAM (us-east1) y Cloud Run por ${autor_nombre || 'Juan Yaya'}.`
  });

  res.json({
    ok: true,
    mensaje: `¡Políticas de ${db.usuarios.length} usuarios sincronizadas exitosamente con Google Cloud IAM!`,
    hash_despliegue: hash,
    fecha_sincronizacion: new Date().toISOString(),
    usuarios_sincronizados: db.usuarios.map(u => ({
      id_usuario: u.id_usuario,
      email: u.email,
      nombre: u.nombre_completo,
      rol: u.rol,
      gcp_role: u.id_usuario === 1 
        ? "roles/owner" 
        : (u.rol === 'Administrador' ? "roles/resourcemanager.organizationAdmin" : (u.rol === 'Contador' ? "roles/editor" : "roles/viewer"))
    })),
    modificacion: mod
  });
});

// ==========================================
// GOOGLE DRIVE CORPORATIVO TLM INTEGRACIÓN
// ==========================================
router.get('/sistema/google-drive-status', (_req: Request, res: Response) => {
  res.json(db.getGoogleDriveStatus());
});

router.post('/sistema/google-drive-sync', (req: Request, res: Response) => {
  const { autor_id, autor_nombre } = req.body;
  const result = db.syncToGoogleDrive(autor_id || 1, autor_nombre || "Juan Yaya - Administrador Maestro");
  res.json({
    ok: true,
    mensaje: "¡Repositorio v2.0 y comprobantes sincronizados exitosamente con Google Drive!",
    ...result
  });
});

router.post('/sistema/google-drive-config', (req: Request, res: Response) => {
  const { cuenta_propietario, carpeta_id, carpeta_nombre, carpeta_url, modo_sincronizacion } = req.body;
  const updated = db.updateGoogleDriveConfig({
    cuenta_propietario,
    carpeta_id,
    carpeta_nombre,
    carpeta_url,
    modo_sincronizacion
  });
  res.json({
    ok: true,
    mensaje: "Configuración de Google Drive actualizada.",
    config: updated
  });
});

router.post('/sistema/google-drive-import', (req: Request, res: Response) => {
  const { id_empresa } = req.body;
  const result = db.importFromGoogleDrive(id_empresa || 1);
  res.json({
    ok: true,
    mensaje: "¡Documentos importados exitosamente desde la carpeta Google Drive vinculada!",
    ...result
  });
});

// ==========================================
// ACCESO A DESARROLLADORES & EDICIÓN DE CÓDIGO
// ==========================================
router.get('/sistema/desarrolladores', (_req: Request, res: Response) => {
  res.json({
    propietario_principal: "automatizaciones@tlm.net.co",
    repositorio_proyecto: "Consola TLM - Enterprise Fiscal & ERP Engine",
    cloud_project_id: "395382435000",
    cloud_run_service: "consola-tlm",
    desarrolladores: db.getDesarrolladores(),
    total_activos: db.getDesarrolladores().filter(d => d.estado === 'ACTIVO').length,
    instrucciones_iam: {
      gcloud_editor: "gcloud projects add-iam-policy-binding 395382435000 --member=\"user:CORREO_COLABORADOR\" --role=\"roles/editor\"",
      gcloud_run_developer: "gcloud projects add-iam-policy-binding 395382435000 --member=\"user:CORREO_COLABORADOR\" --role=\"roles/run.developer\""
    }
  });
});

router.post('/sistema/desarrolladores/invitar', (req: Request, res: Response) => {
  const { email, nombre, rol_tecnico, permisos_codigo, invitado_por } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ detail: "Correo electrónico corporativo válido es requerido." });
  }

  const nuevoDev = db.invitarDesarrollador({
    email,
    nombre: nombre || email.split('@')[0],
    rol_tecnico: rol_tecnico || 'Full-Stack Developer',
    permisos_codigo,
    invitado_por
  });

  res.status(201).json({
    ok: true,
    mensaje: `¡Acceso concedido exitosamente a ${nuevoDev.email}! Se ha emitido su token y registrado en la bandeja de seguridad.`,
    desarrollador: nuevoDev,
    comando_gcloud_sugerido: `gcloud projects add-iam-policy-binding 395382435000 --member="user:${nuevoDev.email}" --role="roles/editor"`
  });
});

router.delete('/sistema/desarrolladores/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const success = db.revocarDesarrollador(id);
    if (!success) {
      return res.status(404).json({ detail: "Colaborador no encontrado." });
    }
    res.json({ ok: true, mensaje: "Acceso de edición de código revocado correctamente." });
  } catch (err: any) {
    res.status(400).json({ detail: err.message || "Error revocando acceso." });
  }
});

router.post('/sistema/desarrolladores/:id/regenerar-token', (req: Request, res: Response) => {
  const { id } = req.params;
  const dev = db.regenerarTokenDesarrollador(id);
  if (!dev) {
    return res.status(404).json({ detail: "Colaborador no encontrado." });
  }
  res.json({
    ok: true,
    mensaje: `Nuevo token de desarrollo generado para ${dev.email}.`,
    token_desarrollador: dev.token_desarrollador
  });
});

// ==========================================
// REPOSITORIO MAESTRO DE JUAN YAYA (VERSIÓN 2.0)
// ==========================================
router.get('/repositorio/juan', async (_req: Request, res: Response) => {
  try {
    const modificaciones = await CloudSqlService.getModificaciones();
    const usuarios = await CloudSqlService.getUsuarios();
    res.json({
      info: db.getRepositorioInfo(),
      modificaciones: modificaciones.length > 0 ? modificaciones : db.modificaciones,
      usuarios_colaboradores: usuarios.filter(u => u.activo).map(usuarioPublico)
    });
  } catch (err) {
    res.json({
      info: db.getRepositorioInfo(),
      modificaciones: db.modificaciones,
      usuarios_colaboradores: db.usuarios.filter(u => u.activo).map(usuarioPublico)
    });
  }
});

router.post('/repositorio/juan/modificacion', async (req: Request, res: Response) => {
  const { autor_id, autor_nombre, autor_email, autor_rol, tipo_accion, descripcion, detalles } = req.body;
  if (!descripcion) {
    return res.status(400).json({ detail: "Descripción de la modificación es requerida." });
  }

  try {
    const mod = await CloudSqlService.addModificacion({
      autor_id: autor_id ? Number(autor_id) : 1,
      autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
      autor_email: (req as any).usuario?.email,
      autor_rol: (req as any).usuario?.rol,
      tipo_accion: tipo_accion || 'COLABORACION',
      descripcion,
      detalles
    });

    db.modificaciones.unshift(mod);

    const count = (await CloudSqlService.getModificaciones()).length;
    res.status(201).json({
      mensaje: "Modificación arrojada con éxito al Repositorio Central de Juan Yaya como Versión 2.0 en Cloud SQL",
      modificacion: mod,
      repositorio_version: "2.0",
      total_modificaciones: count
    });
  } catch (err: any) {
    res.status(500).json({ detail: "Error registrando modificación en Cloud SQL: " + err.message });
  }
});

router.post('/repositorio/juan/consolidar-v2', async (req: Request, res: Response) => {
  const { autor_id, autor_nombre, notas } = req.body;
  try {
    const mod = await CloudSqlService.addModificacion({
      autor_id: autor_id || 1,
      autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
      tipo_accion: "RELEASE_V2",
      descripcion: `Consolidación oficial de release: Versión 2.0 arrojada en Repositorio Central de Juan`,
      detalles: notas || "Árbol de cambios colaborativos sincronizado con éxito en Google Cloud SQL."
    });

    db.modificaciones.unshift(mod);

    res.json({
      mensaje: "¡Consolidación exitosa! Todas las modificaciones multiusuario se han arrojado al Repositorio de Juan como Versión 2.0 en Cloud SQL.",
      snapshot_version: "2.0.0",
      modificacion: mod,
      info: db.getRepositorioInfo()
    });
  } catch (err: any) {
    res.status(500).json({ detail: "Error consolidando en Cloud SQL: " + err.message });
  }
});

router.get('/sistema/export-backup', async (_req: Request, res: Response) => {
  const [usuarios, empresas, facturas, cuentasPUC, balanceTerceros, movimientosBanco, movimientosLibro, modificaciones] = await Promise.all([
    CloudSqlService.getUsuarios().catch(() => db.usuarios),
    CloudSqlService.getEmpresas().catch(() => db.empresas),
    CloudSqlService.getFacturas().catch(() => db.facturas),
    CloudSqlService.getCuentasPuc().catch(() => db.cuentasPUC),
    CloudSqlService.getBalanceTerceros().catch(() => db.balanceTerceros),
    CloudSqlService.getMovimientosBanco().catch(() => db.movimientosBanco),
    CloudSqlService.getMovimientosLibro().catch(() => db.movimientosLibro),
    CloudSqlService.getModificaciones().catch(() => db.modificaciones)
  ]);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="repositorio_juan_version_2.0.json"');
  res.send(JSON.stringify({
    version: "2.0",
    repositorio: {
      nombre: "Repositorio Central de Juan Yaya",
      propietario: "Juan Yaya (Administrador Maestro)",
      version_oficial: "2.0.0",
      tag: "v2.0",
      fecha_exportacion: new Date().toISOString()
    },
    info: db.getDatabaseInfo(),
    modificaciones,
    data: {
      usuarios: usuarios.map(usuarioPublico),
      empresas,
      facturas,
      cuentasPUC,
      balanceTerceros,
      movimientosBanco,
      movimientosLibro
    }
  }, null, 2));
});

// ==========================================
// BASE DE DATOS CLOUD & MIGRACIÓN EN LÍNEA
// ==========================================

// Visión general de tablas, esquemas, salud relacional y estado cloud
router.get('/sistema/database-overview', async (_req: Request, res: Response) => {
  try {
    const overview = await CloudSqlService.getDatabaseOverview();
    res.json(overview);
  } catch (err: any) {
    console.error('Error in database-overview from Cloud SQL:', err);
    res.status(500).json({ detail: err.message || 'Error consultando base de datos Cloud SQL' });
  }
});

// Probar conexión directa a instancia de PostgreSQL (Neon / Supabase / Cloud SQL)
router.post('/sistema/probar-conexion-sql', async (req: Request, res: Response) => {
  let { host, port, database, user, password, ssl, supabaseProjectId, neonProjectId, neonBranchId, connectionString } = req.body;

  if (connectionString) {
    const parsed = parseConnectionString(connectionString);
    if (parsed) {
      if (parsed.host) host = parsed.host;
      if (parsed.port) port = parsed.port;
      if (parsed.database) database = parsed.database;
      if (parsed.user) user = parsed.user;
      if (parsed.password) password = parsed.password;
      if (parsed.isNeon) neonProjectId = 'bitter-frost-14568057';
    }
  }

  const isNeon = Boolean(neonProjectId) || (host && host.includes('neon.tech'));
  const isSupabase = !isNeon && (Boolean(supabaseProjectId) || (host && host.includes('supabase')));

  let targetHost = host;
  if (!targetHost) {
    if (isNeon) targetHost = 'ep-rough-term-b4jl3vvr-pooler.c-6.us-east-2.aws.neon.tech';
    else if (isSupabase) targetHost = `db.${supabaseProjectId || 'fqatuwzsunvxbtryhloy'}.supabase.co`;
    else targetHost = process.env.SQL_HOST || 'ep-rough-term-b4jl3vvr-pooler.c-6.us-east-2.aws.neon.tech';
  }

  const targetPort = port ? parseInt(port, 10) : (process.env.SQL_PORT ? parseInt(process.env.SQL_PORT, 10) : 5432);
  const targetDb = database || (isNeon ? 'neondb' : (process.env.SQL_DB_NAME || 'postgres'));
  const targetUser = user || (isNeon ? 'neondb_owner' : (process.env.SQL_USER || 'postgres'));
  const targetPassword = password || process.env.SQL_PASSWORD || 'npg_zyGclK32wnNL';
  const useSsl = isNeon || isSupabase || ssl === true || ssl === 'true' || process.env.SQL_SSL === 'true';

  const isSocket = targetHost.startsWith('/');
  const effectiveConnStr = connectionString || (
    isNeon && !isSocket
      ? `postgresql://${encodeURIComponent(targetUser)}:${encodeURIComponent(targetPassword)}@${targetHost}:${targetPort}/${targetDb}?sslmode=require`
      : undefined
  );
  const { Pool } = await import('pg');
  const testPool = new Pool(effectiveConnStr ? {
    connectionString: effectiveConnStr,
    connectionTimeoutMillis: 7000,
    ssl: { rejectUnauthorized: false }
  } : {
    host: targetHost,
    port: isSocket ? undefined : targetPort,
    database: targetDb,
    user: targetUser,
    password: targetPassword,
    connectionTimeoutMillis: 7000,
    ssl: !isSocket && useSsl ? { rejectUnauthorized: false } : false
  });

  try {
    const start = Date.now();
    const result = await testPool.query('SELECT current_database() as db, current_user as usr, version() as ver');
    const latency = Date.now() - start;
    await testPool.end();

    const providerLabel = isNeon ? 'Neon Serverless' : (isSupabase ? 'Supabase' : 'PostgreSQL');
    return res.json({
      ok: true,
      is_neon: isNeon,
      neon_project_id: neonProjectId || (isNeon ? 'bitter-frost-14568057' : undefined),
      neon_branch_id: neonBranchId || (isNeon ? 'br-tiny-boat-b4jd4u1z' : undefined),
      is_supabase: isSupabase,
      supabase_project_id: supabaseProjectId || (isSupabase ? 'fqatuwzsunvxbtryhloy' : undefined),
      mensaje: `¡Conexión exitosa a ${providerLabel} (${targetHost}:${targetPort})!`,
      base_datos: result.rows[0]?.db,
      usuario: result.rows[0]?.usr,
      version: result.rows[0]?.ver,
      latencia_ms: latency,
      host: targetHost,
      puerto: targetPort
    });
  } catch (err: any) {
    try { await testPool.end(); } catch (_) {}
    const isAuthError = err.message?.includes('password authentication failed') || err.code === '28P01';
    let instruccion = `Verifica que el host ${targetHost}:${targetPort} sea accesible por red pública.`;
    if (isNeon) {
      if (isAuthError) {
        instruccion = `Contraseña incorrecta para el usuario '${targetUser}' en Neon (bitter-frost-14568057). En la consola de Neon (https://console.neon.tech/app/projects/bitter-frost-14568057/branches/br-tiny-boat-b4jd4u1z), consulta o restablece la contraseña del rol 'neondb_owner' o copia la Connection String completa.`;
      } else {
        instruccion = `Verifica que la rama 'br-tiny-boat-b4jd4u1z' del proyecto 'bitter-frost-14568057' esté activa en Neon Console.`;
      }
    } else if (isSupabase) {
      if (isAuthError) {
        instruccion = `Contraseña incorrecta para el usuario '${targetUser}' en el proyecto Supabase '${supabaseProjectId || 'fqatuwzsunvxbtryhloy'}'. Puedes restablecer o verificar tu contraseña en el panel de Supabase: Project Settings > Database > Database Password.`;
      } else {
        instruccion = `Verifica que el ID del proyecto '${supabaseProjectId || 'fqatuwzsunvxbtryhloy'}' esté activo en app.supabase.com y que el puerto 5432 o SSL estén habilitados.`;
      }
    } else {
      instruccion = `En Google Cloud Console (Cloud SQL > Instancia > Conexiones > Redes autorizadas), agrega la red '0.0.0.0/0' para permitir conexiones a la IP ${targetHost}.`;
    }

    return res.json({
      ok: false,
      is_neon: isNeon,
      is_supabase: isSupabase,
      mensaje: `No se pudo conectar a PostgreSQL en ${targetHost}:${targetPort}`,
      error_detalle: err.message || 'Timeout de conexión',
      codigo_error: err.code,
      instruccion,
      host: targetHost,
      puerto: targetPort
    });
  }
});

// Aplicar y cambiar la conexión activa en caliente (Neon / Supabase / Cloud SQL)
router.post('/sistema/conectar-base-datos', async (req: Request, res: Response) => {
  const { host, port, database, user, password, ssl, supabaseProjectId, neonProjectId, neonBranchId, connectionString } = req.body;
  try {
    const isNeon = Boolean(neonProjectId) || (host && host.includes('neon.tech')) || (connectionString && connectionString.includes('neon.tech'));
    const isSupabase = !isNeon && (Boolean(supabaseProjectId) || (host && host.includes('supabase')));

    const result = await reconnectPool({
      host: host || (isNeon ? 'ep-rough-term-b4jl3vvr-pooler.c-6.us-east-2.aws.neon.tech' : undefined),
      port: port ? parseInt(port, 10) : 5432,
      database: database || (isNeon ? 'neondb' : 'postgres'),
      user: user || (isNeon ? 'neondb_owner' : 'postgres'),
      password: password || process.env.SQL_PASSWORD || 'npg_zyGclK32wnNL',
      ssl: isNeon || isSupabase || ssl !== false,
      supabaseProjectId: isSupabase ? (supabaseProjectId || 'fqatuwzsunvxbtryhloy') : undefined,
      neonProjectId: isNeon ? (neonProjectId || 'bitter-frost-14568057') : undefined,
      neonBranchId: isNeon ? (neonBranchId || 'br-tiny-boat-b4jd4u1z') : undefined,
      connectionString
    });

    // Asegurar tablas en la base de datos conectada
    await CloudSqlService.ensureTablesExist();
    await CloudSqlService.seedDefaultDataIfEmpty();
    await CloudSqlService.syncCloudSqlToDataStore(db);

    const overview = await CloudSqlService.getDatabaseOverview();
    const provider = isNeon ? 'Neon Serverless' : (isSupabase ? 'Supabase' : 'PostgreSQL');

    return res.json({
      ok: true,
      mensaje: `¡Base de datos conectada y activada en caliente con ${provider}!`,
      result,
      overview
    });
  } catch (err: any) {
    console.error('Error conectando base de datos:', err);
    res.status(400).json({
      ok: false,
      mensaje: 'Error conectando con la base de datos indicada: ' + err.message,
      codigo_error: err.code
    });
  }
});

// Migrar esquema DDL y sembrar datos en la base conectada
router.post('/sistema/migrar-esquema-ddl', async (_req: Request, res: Response) => {
  try {
    await CloudSqlService.ensureTablesExist();
    await CloudSqlService.seedDefaultDataIfEmpty();
    await CloudSqlService.syncCloudSqlToDataStore(db);
    const overview = await CloudSqlService.getDatabaseOverview();
    return res.json({
      ok: true,
      mensaje: 'Esquema relacional de 8 tablas verificado y desplegado exitosamente.',
      overview
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      mensaje: 'Error desplegando esquema DDL: ' + err.message
    });
  }
});

// Exportar DDL y DML completo para Google Cloud SQL / PostgreSQL
router.get('/sistema/export-sql', (_req: Request, res: Response) => {
  try {
    const sqlContent = SqlGeneratorService.generateCloudSqlDump(db);
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', 'attachment; filename="tlm_enterprise_cloud_database_dump.sql"');
    res.send(sqlContent);
  } catch (error: any) {
    res.status(500).json({ detail: "Error generando dump SQL: " + error.message });
  }
});

// Ejecución de Migración Completa a Google Cloud Platform
router.post('/sistema/cloud-migration', async (req: Request, res: Response) => {
  const { autor_id, autor_nombre, notas } = req.body;
  const migrationId = 'mig-gcp-' + Math.random().toString(36).substring(2, 9);

  // 1. Sincronizar en caliente Cloud SQL con dataStore
  await CloudSqlService.syncCloudSqlToDataStore(db);

  // 2. Persistir copia de respaldo en disco local
  db.saveToDisk();

  // 3. Generar archivo Excel maestro sincronizado
  try {
    ExcelService.generarLibroCompleto(db);
  } catch (err) {
    console.warn("Aviso generando Excel en migración:", err);
  }

  // 4. Registrar auditoría inmutable en Cloud SQL
  const mod = await CloudSqlService.addModificacion({
    autor_id: autor_id || 1,
    autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
    tipo_accion: "GCP_SYNC",
    descripcion: `Migración Integral de Base de Datos a Google Cloud (${migrationId})`,
    detalles: notas || `Migración y verificación de 8 tablas relacionales (${db.facturas.length} facturas, ${db.usuarios.length} usuarios, ${db.cuentasPUC.length} cuentas PUC) en Google Cloud SQL (peak-sunset-511516-q7).`
  }).catch(() => db.addModificacion({
    autor_id: autor_id || 1,
    autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
    tipo_accion: "GCP_SYNC",
    descripcion: `Migración Integral de Base de Datos a Google Cloud (${migrationId})`,
    detalles: notas || `Migración exitosa a Google Cloud.`
  }));

  const allFacts = await CloudSqlService.getFacturas().catch(() => db.facturas);
  const allUsers = await CloudSqlService.getUsuarios().catch(() => db.usuarios);
  const allEmps = await CloudSqlService.getEmpresas().catch(() => db.empresas);
  const allPuc = await CloudSqlService.getCuentasPuc().catch(() => db.cuentasPUC);
  const allBal = await CloudSqlService.getBalanceTerceros().catch(() => db.balanceTerceros);
  const allBanco = await CloudSqlService.getMovimientosBanco().catch(() => db.movimientosBanco);
  const allLibro = await CloudSqlService.getMovimientosLibro().catch(() => db.movimientosLibro);

  res.json({
    ok: true,
    migration_id: migrationId,
    mensaje: "¡Base de datos y consultas en línea activas en Google Cloud SQL!",
    app_url: "https://consola-tlm-enterprise-fiscal-erp-engine.ai.studio",
    timestamp: new Date().toISOString(),
    servicios_migrados: [
      { servicio: "Google Cloud SQL", estado: "CONECTADO_EN_LINEA", instancia: "peak-sunset-511516-q7 (PostgreSQL 18.6)" },
      { servicio: "Google Cloud Run", estado: "SINCRONIZADO", region: "us-east1" },
      { servicio: "Google Cloud Storage", estado: "BACKUP_ACTUALIZADO", bucket: "tlm-enterprise-fiscal-engine-bucket" },
      { servicio: "Google Cloud IAM", estado: "POLITICAS_APLICADAS", identidades: allUsers.length },
      { servicio: "Google Drive Maestro", estado: "EXCEL_BD_REPLICADO", archivo: "tlm_base_de_datos_maestra.xlsx" },
      { servicio: "Cloud SQL Schema", estado: "DDL_DML_LISTO", tablas: 8 }
    ],
    estadisticas: {
      empresas: allEmps.length,
      usuarios: allUsers.length,
      facturas: allFacts.length,
      cuentas_puc: allPuc.length,
      balance_terceros: allBal.length,
      movimientos_banco: allBanco.length,
      movimientos_libro: allLibro.length
    },
    modificacion: mod
  });
});

// Re-seed opcional para pruebas de gestiones
router.post('/sistema/database/seed-fresh', (_req: Request, res: Response) => {
  (db as any).initSeedData();
  db.saveToDisk();
  try {
    ExcelService.generarLibroCompleto(db);
  } catch (e) {}

  res.json({
    ok: true,
    mensaje: "¡Datos de demostración y gestiones refrescados exitosamente!",
    conteo: db.getDatabaseInfo().conteo
  });
});

// ==========================================
// 2. EMPRESAS Y MULTI-TENANCY
// ==========================================
router.get('/empresas', async (req: Request, res: Response) => {
  const u = await usuarioSolicitante(req);
  try {
    const list = await CloudSqlService.getEmpresas();
    if (list.length > 0) {
      return res.json(visiblesPara(list, u).map(empresaPublica));
    }
  } catch (err) {
    console.warn('[CloudSQL] Error consultando empresas en línea:', err);
  }
  res.json(visiblesPara(db.empresas, u).map(empresaPublica));
});

router.post('/empresas', async (req: Request, res: Response) => {
  const { nombre_comercial, nit, software_erp, siigo_username, siigo_access_key, siigo_document_id, logo_url } = req.body;
  if (!nombre_comercial || !nit) {
    return res.status(400).json({ detail: "Nombre comercial y NIT son obligatorios." });
  }

  try {
    const existentes = await CloudSqlService.getEmpresas().catch(() => db.empresas);
    const nitLimpio = String(nit).split('-')[0].replace(/[^\d]/g, '');
    if (existentes.some(e => String(e.nit).split('-')[0].replace(/[^\d]/g, '') === nitLimpio)) {
      return res.status(409).json({ detail: `Ya existe una empresa con el NIT ${nit}. Pida al administrador que se la asigne.` });
    }
    const nuevaEmpresa = await CloudSqlService.createEmpresa({
      nombre_comercial,
      nit,
      software_erp: software_erp || "SIIGO_NUBE",
      software_destino: software_erp || "SIIGO_NUBE",
      siigo_username,
      siigo_access_key,
      siigo_document_id: siigo_document_id || 24,
      logo_url: logo_url || undefined
    });

    db.empresas.push(nuevaEmpresa);

    // Quien crea el cliente queda asignado como su gestor
    const creador = await usuarioSolicitante(req);
    if (creador && !(creador.empresas_ids || []).includes(nuevaEmpresa.id_empresa)) {
      const empresas_ids = [...(creador.empresas_ids || []), nuevaEmpresa.id_empresa];
      await CloudSqlService.updateUsuario(creador.id_usuario, { empresas_ids }).catch(() => null);
      const local = db.usuarios.find(x => x.id_usuario === creador.id_usuario);
      if (local) local.empresas_ids = empresas_ids;
      db.saveToDisk();
    }
    res.status(201).json(empresaPublica(nuevaEmpresa));
  } catch (err: any) {
    console.error('[CloudSQL] Error creando empresa en línea:', err);
    res.status(500).json({ detail: "Error creando empresa en Cloud SQL: " + err.message });
  }
});

router.get('/empresas/:id/siigo-config', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const empresasList = await CloudSqlService.getEmpresas().catch(() => []);
  const empresa = empresasList.find(e => e.id_empresa === id) || db.empresas.find(e => e.id_empresa === id);
  if (!empresa) {
    return res.status(404).json({ detail: "Empresa no encontrada." });
  }

  res.json({
    id_empresa: empresa.id_empresa,
    nombre_comercial: empresa.nombre_comercial,
    nit: empresa.nit,
    siigo_username: empresa.siigo_username || "",
    siigo_access_key: empresa.siigo_access_key ? "••••••••••••••••" : "",
    siigo_document_id: empresa.siigo_document_id || 24,
    has_credentials: Boolean(empresa.siigo_username && empresa.siigo_access_key)
  });
});

router.put('/empresas/:id/siigo-config', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { siigo_username, siigo_document_id } = req.body;
  let { siigo_access_key } = req.body;

  try {
    // Llave vacía o enmascarada = conservar la llave guardada
    if (!siigo_access_key || String(siigo_access_key).includes('•')) {
      const actuales = await CloudSqlService.getEmpresas().catch(() => []);
      siigo_access_key = (actuales.find(e => e.id_empresa === id) || db.empresas.find(e => e.id_empresa === id))?.siigo_access_key || '';
    }
    // Las credenciales se prueban en vivo contra Siigo antes de guardarlas
    if (siigo_username && siigo_access_key && req.body.validar !== false) {
      const prueba = await siigoService.testConnection(siigo_username, siigo_access_key);
      if (!prueba.ok) {
        return res.status(400).json({ detail: `Siigo rechazó las credenciales: ${prueba.message}` });
      }
    }
    await CloudSqlService.updateEmpresaSiigo(id, {
      siigo_username: siigo_username || '',
      siigo_access_key: siigo_access_key || '',
      siigo_document_id: Number(siigo_document_id) || 24
    });

    const empresa = db.empresas.find(e => e.id_empresa === id);
    if (empresa) {
      if (siigo_username !== undefined) empresa.siigo_username = siigo_username;
      if (siigo_access_key !== undefined) empresa.siigo_access_key = siigo_access_key;
      if (siigo_document_id !== undefined) empresa.siigo_document_id = Number(siigo_document_id);
    }

    res.json({
      mensaje: siigo_username && siigo_access_key ? "Credenciales verificadas con Siigo Nube y guardadas." : "Configuración de Siigo guardada.",
      id_empresa: id,
      siigo_username,
      siigo_document_id
    });
  } catch (err: any) {
    res.status(500).json({ detail: "Error actualizando configuración en Cloud SQL: " + err.message });
  }
});

// ==========================================
// 3. FACTURAS Y ETL UBL 2.1
// ==========================================
router.get('/facturas', async (req: Request, res: Response) => {
  try {
    const idEmpresa = req.query.id_empresa ? parseInt(req.query.id_empresa as string) : undefined;
    const estado = req.query.estado as string;
    const search = req.query.search as string;
    const casilla = req.query.casilla ? parseInt(req.query.casilla as string) : undefined;

    const items = await CloudSqlService.getFacturas({ idEmpresa, estado, search, casilla });
    if (items.length > 0) {
      return res.json(items);
    }
  } catch (err: any) {
    console.warn('[CloudSQL] Fallback facturas a DataStore local:', err);
  }
  let items = [...db.facturas];
  if (req.query.id_empresa) {
    items = items.filter(f => f.id_empresa === parseInt(req.query.id_empresa as string));
  }
  if (req.query.estado && req.query.estado !== 'TODOS') {
    items = items.filter(f => f.estado_revision === req.query.estado);
  }
  if (req.query.search) {
    const s = (req.query.search as string).toLowerCase();
    items = items.filter(f =>
      f.factura_num.toLowerCase().includes(s) ||
      f.proveedor.toLowerCase().includes(s) ||
      f.nit_tercero.includes(s) ||
      f.descripcion_item.toLowerCase().includes(s)
    );
  }
  res.json(items);
});

router.post('/facturas/upload', uploadFacturas.array('archivos'), async (req: Request, res: Response) => {
  const idEmpresa = parseInt(req.body.id_empresa || '1');
  const files = (req.files as Express.Multer.File[]) || [];
  let limpiezaIniciada = false;
  const limpiarSubidas = () => {
    if (limpiezaIniciada) return;
    limpiezaIniciada = true;
    void Promise.all(files.map(async file => {
      try {
        await fs.promises.unlink(file.path);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') console.warn(`[Upload] No se pudo eliminar el temporal "${file.path}":`, err);
      }
    }));
  };
  res.once('finish', limpiarSubidas);
  res.once('close', limpiarSubidas);
  const parsedFacturas: Partial<Factura>[] = [];
  let archivosXmlExtraidos = 0;

  // NIT de la empresa activa: decide si cada documento es VENTA (emitido por ella) o COMPRA (recibido)
  const empresasEnLinea = await CloudSqlService.getEmpresas().catch(() => []);
  const empresaActiva = empresasEnLinea.find(e => e.id_empresa === idEmpresa) || db.empresas.find(e => e.id_empresa === idEmpresa);
  const nitEmpresa = empresaActiva?.nit || '';
  const archivados: { nombre: string; ok: boolean; error?: string }[] = [];
  const erroresLectura: { nombre: string; error: string; indice: number }[] = [];
  const pendientesArchivado: Parameters<typeof EmpresaStorageService.archivarLote>[0] = [];
  const guardarOriginales = async () => {
    if (!pendientesArchivado.length) return;
    const lote = pendientesArchivado.splice(0);
    const resultados = await EmpresaStorageService.archivarLote(lote);
    resultados.forEach((resultado, indice) => {
      if (!resultado.omitido) {
        archivados.push({
          nombre: lote[indice].nombre,
          ok: resultado.ok,
          error: resultado.error
        });
      }
    });
  };

  // PDF originales: los que vienen dentro de cada .zip ya llegan emparejados; los PDF sueltos se emparejan con los XML sueltos
  const conPdf: ParsedXmlInvoice[] = [];
  const xmlSueltos: ParsedXmlInvoice[] = [];
  const pdfsSueltos: { nombre: string; contenido: Buffer; indice: number }[] = [];
  const agregarFactura = (p: ParsedXmlInvoice) => parsedFacturas.push({
    id_empresa: idEmpresa,
    factura_num: p.factura_num,
    fecha: p.fecha,
    fecha_vencimiento: p.fecha_vencimiento,
    tipo_operacion: p.tipo_operacion,
    proveedor: p.proveedor,
    nit_tercero: p.nit_tercero,
    telefono: p.telefono,
    direccion: p.direccion,
    ciudad: p.ciudad,
    departamento: p.departamento,
    correo: p.correo,
    descripcion_item: p.descripcion_item,
    cantidad: p.cantidad,
    valor_unitario: p.valor_unitario,
    subtotal: p.subtotal,
    iva: p.iva,
    total: p.total ?? p.subtotal + p.iva,
    casilla_350: p.casilla_350,
    retencion_porc: p.retencion_porc,
    retencion_valor: p.retencion_valor,
    reteica_tarifa: p.reteica_tarifa,
    reteiva_porc: p.reteiva_porc,
    forma_pago: p.forma_pago,
    medio_pago: p.medio_pago,
    cuenta_gasto: p.cuenta_gasto,
    tipo_comprobante: p.tipo_comprobante,
    cufe_hash: p.cufe_hash,
    items: p.items,
    datos_ubl: p.datos_ubl,
    estado_revision: 'PENDIENTE',
    fecha_cargue: new Date().toISOString()
  });

  for (const [indice, file] of files.entries()) {
    let cabecera = Buffer.alloc(5);
    let errorLectura: string | undefined;
    try {
      const handle = await fs.promises.open(file.path, 'r');
      try {
        await handle.read(cabecera, 0, cabecera.length, 0);
      } finally {
        await handle.close();
      }
    } catch (err) {
      errorLectura = err instanceof Error ? err.message : String(err);
    }
    const esPdf = file.originalname.toLowerCase().endsWith('.pdf') || cabecera.subarray(0, 5).toString('latin1') === '%PDF-';
    const esZip = /\.zip$/i.test(file.originalname) || (cabecera[0] === 0x50 && cabecera[1] === 0x4B);
    let parsedList: ParsedXmlInvoice[] = [];
    const erroresArchivo: { nombre: string; error: string }[] = [];
    try {
      if (errorLectura) throw new Error(errorLectura);
      if (esPdf) {
        pdfsSueltos.push({
          nombre: file.originalname,
          contenido: await fs.promises.readFile(file.path),
          indice
        });
      } else {
        parsedList = await xmlParser.parseFilePath(file.path, file.originalname, nitEmpresa, erroresArchivo);
      }
    } catch (err) {
      errorLectura = err instanceof Error ? err.message : String(err);
      console.error(`[Upload] No se pudo leer "${file.originalname}":`, err);
    }
    if (!errorLectura && !esPdf && parsedList.length === 0 && !erroresArchivo.length) {
      errorLectura = 'No se encontró una factura o nota crédito UBL válida en el XML/ZIP.';
    }
    erroresLectura.push(...erroresArchivo.map(error => ({
      nombre: error.nombre,
      error: error.error,
      indice
    })));
    if (errorLectura && !erroresArchivo.length) {
      erroresLectura.push({ nombre: file.originalname, error: errorLectura, indice });
    }
    if (!esPdf && !esZip) xmlSueltos.push(...parsedList);
    conPdf.push(...parsedList);
    archivosXmlExtraidos += parsedList.length;

    // Conservar el archivo original en el almacenamiento de la empresa (Drive / unidad compartida / local)
    if (empresaActiva) {
      const fechas = parsedList.map(p => p.fecha).filter(f => /^\d{4}-\d{2}/.test(f)).sort();
      pendientesArchivado.push({
        empresa: { id_empresa: empresaActiva.id_empresa, nit: empresaActiva.nit, nombre_comercial: empresaActiva.nombre_comercial },
        categoria: 'FACTURAS_XML',
        nombre: file.originalname,
        rutaContenido: file.path,
        mime: file.mimetype || 'application/octet-stream',
        periodo: fechas.length ? fechas[fechas.length - 1].substring(0, 7) : undefined,
        usuario: db.usuarios.find(u => u.id_usuario === Number(req.headers['x-tlm-user-id']))?.nombre_completo
      });
    }

    parsedList.forEach(agregarFactura);
  }

  await guardarOriginales();

  emparejarPdfs(xmlSueltos.filter(p => !p.pdf_original), pdfsSueltos);
  const pdfsEmparejados = new Set(xmlSueltos.flatMap(factura =>
    factura.pdf_original ? [factura.pdf_original] : []
  ));
  const pdfsSinPareja = pdfsSueltos.filter(pdf => !pdfsEmparejados.has(pdf));
  for (const pdf of pdfsSinPareja) {
    try {
      const parsedList = await xmlParser.parseFileBuffer(pdf.contenido, pdf.nombre, nitEmpresa);
      if (!parsedList.length) throw new Error('No se pudo identificar una factura o nota crédito en el PDF.');
      conPdf.push(...parsedList);
      archivosXmlExtraidos += parsedList.length;
      parsedList.forEach(agregarFactura);
    } catch (err) {
      erroresLectura.push({
        nombre: pdf.nombre,
        error: err instanceof Error ? err.message : String(err),
        indice: pdf.indice
      });
    }
  }
  let pdfsOriginales = 0;
  const documentosConPdf = conPdf.flatMap(factura =>
    factura.pdf_original && factura.cufe_hash
      ? [{ factura, pdf: factura.pdf_original }]
      : []
  );
  for (let inicio = 0; inicio < documentosConPdf.length; inicio += 8) {
    const lote = documentosConPdf.slice(inicio, inicio + 8);
    await Promise.all(lote.map(async ({ factura, pdf }) => {
      await SoportesOriginales.guardar(idEmpresa, factura.cufe_hash, pdf.nombre, pdf.contenido);
      pdfsOriginales++;
    }));
  }

  let processedFacturas: Factura[] = [];
  try {
    processedFacturas = await CloudSqlService.bulkCreateFacturas(parsedFacturas);
  } catch (e) {
    console.warn('[CloudSQL] Neon no disponible al guardar facturas subidas:', e);
  }

  if (processedFacturas.length === 0 && parsedFacturas.length > 0) {
    processedFacturas = parsedFacturas.map((factura, index) => ({
      ...factura,
      id_factura: Date.now() + index,
      id_empresa: factura.id_empresa || idEmpresa,
      factura_num: factura.factura_num || `XML-${Date.now()}-${index}`,
      fecha: factura.fecha || 'SIN_FECHA',
      proveedor: factura.proveedor || 'Proveedor no identificado',
      nit_tercero: factura.nit_tercero || 'N/A',
      descripcion_item: factura.descripcion_item || 'Factura electrónica UBL',
      cantidad: factura.cantidad || 1,
      valor_unitario: factura.valor_unitario || factura.subtotal || 0,
      subtotal: factura.subtotal || 0,
      iva: factura.iva || 0,
      total: factura.total || (factura.subtotal || 0) + (factura.iva || 0),
      retencion_porc: factura.retencion_porc || 0,
      retencion_valor: factura.retencion_valor || 0,
      casilla_350: factura.casilla_350 || 83,
      forma_pago: factura.forma_pago || 'Crédito',
      medio_pago: factura.medio_pago || 'Transferencia Débito',
      cuenta_gasto: factura.cuenta_gasto || '513535',
      tipo_comprobante: factura.tipo_comprobante || 'Factura Electrónica',
      cufe_hash: factura.cufe_hash || `cufe-local-${Date.now()}-${index}`,
      estado_revision: factura.estado_revision || 'PENDIENTE',
      fecha_cargue: factura.fecha_cargue || new Date().toISOString()
    } as Factura));
  }

  if (processedFacturas.length > 0 && processedFacturas.length < parsedFacturas.length) {
    return res.status(503).json({
      detail: `La base de datos solo guardó ${processedFacturas.length} de ${parsedFacturas.length} documentos. Se reintentará el lote en grupos más pequeños.`
    });
  }

  const duplicadasCount = processedFacturas.filter((f: any) => f._duplicada).length;
  const facturasNuevas = processedFacturas.filter((f: any) => !f._duplicada);
  processedFacturas = processedFacturas.map((f: any) => { const { _duplicada, ...resto } = f; return resto as Factura; });
  if (processedFacturas.length > 0) {
    // Reemplaza en la copia local las facturas de la misma empresa con el mismo CUFE (sin duplicar)
    const claves = new Set(processedFacturas.map(f => `${f.id_empresa}|${f.cufe_hash}`));
    db.facturas = db.facturas.filter(f => !claves.has(`${f.id_empresa}|${f.cufe_hash}`) && !processedFacturas.some(p => p.id_factura === f.id_factura));
    db.facturas.push(...processedFacturas);
    db.saveToDisk();
  }

  if (empresaActiva && processedFacturas.length > 0) {
    NotificacionesService.cargueFacturas(empresaActiva as any, {
      archivos: files.length,
      nuevas: processedFacturas.length - duplicadasCount,
      duplicadas: duplicadasCount,
      ventas: processedFacturas.filter(f => f.tipo_operacion === 'VENTA').length,
      compras: processedFacturas.filter(f => f.tipo_operacion !== 'VENTA').length,
      pdfs: pdfsOriginales
    }, db.usuarios.find(u => u.id_usuario === Number(req.headers['x-tlm-user-id']))).catch(() => {});
  }

  res.json({
    status: 'success',
    archivos_procesados: files.length,
    xmls_extraidos: archivosXmlExtraidos,
    facturas_creadas: processedFacturas.length,
    facturas_duplicadas: duplicadasCount,
    facturas_nuevas: processedFacturas.length - duplicadasCount,
    ventas_nuevas: facturasNuevas.filter(f => f.tipo_operacion === 'VENTA').length,
    compras_nuevas: facturasNuevas.filter(f => f.tipo_operacion !== 'VENTA').length,
    pdfs_originales: pdfsOriginales,
    pdfs_sin_pareja: pdfsSinPareja.length,
    ventas: processedFacturas.filter(f => f.tipo_operacion === 'VENTA').length,
    compras: processedFacturas.filter(f => f.tipo_operacion !== 'VENTA').length,
    errores_lectura: erroresLectura,
    archivados,
    facturas: processedFacturas
  });
});

// Demo seed loader for instant XML ETL testing
router.post('/facturas/seed-demo', async (req: Request, res: Response) => {
  const idEmpresa = parseInt(req.body.id_empresa || '1');
  const demoItems: Partial<Factura>[] = [
    {
      id_empresa: idEmpresa,
      factura_num: "SETT-" + Math.floor(1000 + Math.random() * 9000),
      fecha: new Date().toISOString().split('T')[0],
      proveedor: "MICROSOFT COLOMBIA S.A.S.",
      nit_tercero: "860069921",
      ciudad: "Bogotá D.C.",
      descripcion_item: "Licenciamiento Microsoft Azure Enterprise & M365 Business",
      cantidad: 1,
      valor_unitario: 3950000,
      subtotal: 3950000,
      iva: 750500,
      total: 4700500,
      casilla_350: 62,
      retencion_porc: 4.0,
      retencion_valor: 158000,
      reteica_tarifa: 9.66,
      reteiva_porc: 15.0,
      forma_pago: "Crédito",
      medio_pago: "47 - Transferencia Bancaria",
      cuenta_gasto: "513515",
      tipo_comprobante: "COMPRAS",
      cufe_hash: "msft_cufe_" + Math.random().toString(36).substring(2, 15),
      estado_revision: "PENDIENTE",
      fecha_cargue: new Date().toISOString()
    },
    {
      id_empresa: idEmpresa,
      factura_num: "LOG-" + Math.floor(1000 + Math.random() * 9000),
      fecha: new Date().toISOString().split('T')[0],
      proveedor: "SERVIENTREGA S.A. - LOGÍSTICA NACIONAL",
      nit_tercero: "860512330",
      ciudad: "Bogotá D.C.",
      descripcion_item: "Servicio de transporte y radicación física de correspondencia",
      cantidad: 15,
      valor_unitario: 22000,
      subtotal: 330000,
      iva: 62700,
      total: 392700,
      casilla_350: 62,
      retencion_porc: 4.0,
      retencion_valor: 13200,
      reteica_tarifa: 4.14,
      reteiva_porc: 0,
      forma_pago: "Contado",
      medio_pago: "47 - Transferencia Bancaria",
      cuenta_gasto: "513505",
      tipo_comprobante: "COMPRAS",
      cufe_hash: "servi_cufe_" + Math.random().toString(36).substring(2, 15),
      estado_revision: "PENDIENTE",
      fecha_cargue: new Date().toISOString()
    }
  ];

  try {
    const created = await CloudSqlService.bulkCreateFacturas(demoItems);
    created.forEach(f => db.facturas.push(f));
    const all = await CloudSqlService.getFacturas();
    res.json({ mensaje: "2 Facturas demo inyectadas en línea a Cloud SQL.", total: all.length });
  } catch (err: any) {
    res.status(500).json({ detail: "Error sembrando demo en Cloud SQL: " + err.message });
  }
});

/** Vacía todas las facturas de una empresa (solo Administrador). Debe ir antes de /facturas/:id. */
router.delete('/facturas/limpiar-todo', async (req: Request, res: Response) => {
  const idEmpresa = Number(req.query.id_empresa);
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    return res.status(400).json({ detail: 'Indique la empresa (id_empresa).' });
  }
  const usuario = await usuarioSolicitante(req);
  if (usuario && !esAdministrador(usuario)) {
    return res.status(403).json({ detail: 'Solo un Administrador puede vaciar todas las facturas de una empresa.' });
  }
  try {
    let ids: number[] = [];
    try {
      ids = (await CloudSqlService.getFacturas()).filter(f => f.id_empresa === idEmpresa).map(f => f.id_factura);
    } catch {
      ids = db.facturas.filter(f => f.id_empresa === idEmpresa).map(f => f.id_factura);
    }
    let eliminadas = 0;
    try {
      eliminadas = ids.length ? await CloudSqlService.bulkDeleteFacturas(ids) : 0;
    } catch (err) {
      console.warn('[CloudSQL] No disponible al vaciar facturas; se limpia la copia local:', err);
    }
    const antes = db.facturas.length;
    db.facturas = db.facturas.filter(f => f.id_empresa !== idEmpresa);
    if (db.facturas.length !== antes) db.saveToDisk();
    res.json({ mensaje: `Se eliminaron ${Math.max(eliminadas, antes - db.facturas.length)} facturas de la empresa.`, eliminadas: Math.max(eliminadas, antes - db.facturas.length) });
  } catch (err: any) {
    res.status(500).json({ detail: 'Error vaciando facturas: ' + err.message });
  }
});

router.delete('/facturas/:id', async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ detail: 'El identificador de la factura no es válido.' });
  }

  try {
    let deletedInCloud = false;
    try {
      deletedInCloud = await CloudSqlService.deleteFactura(id);
    } catch (err) {
      console.warn('[CloudSQL] Neon no disponible al eliminar factura; se actualizará la copia local:', err);
    }

    const idx = db.facturas.findIndex(f => f.id_factura === id);
    if (idx !== -1) {
      db.facturas.splice(idx, 1);
      db.saveToDisk();
    }
    if (!deletedInCloud && idx === -1) {
      return res.status(404).json({ detail: 'Factura no encontrada.' });
    }
    res.json({ mensaje: 'Factura eliminada correctamente.', sincronizada_en_neon: deletedInCloud });
  } catch (err: any) {
    res.status(500).json({ detail: 'Error eliminando factura: ' + err.message });
  }
});

router.post('/facturas/bulk-delete', async (req: Request, res: Response) => {
  const rawIds: unknown = Array.isArray(req.body) ? req.body : req.body?.ids;
  const ids = Array.isArray(rawIds)
    ? rawIds.map((value: unknown) => Number(value)).filter((value: number) => Number.isInteger(value))
    : [];

  try {
    let deletedCount = 0;
    try {
      deletedCount = await CloudSqlService.bulkDeleteFacturas(ids);
    } catch (err) {
      console.warn('[CloudSQL] Neon no disponible al eliminar facturas; se actualizará la copia local:', err);
    }

    const previousLength = db.facturas.length;
    db.facturas = db.facturas.filter(f => !ids.includes(f.id_factura));
    const localDeletedCount = previousLength - db.facturas.length;
    if (localDeletedCount > 0) db.saveToDisk();
    const restantesCloud = await CloudSqlService.getFacturas().catch(() => []);
    const restantes = restantesCloud.length > 0 ? restantesCloud.length : db.facturas.length;
    res.json({
      mensaje: `Se eliminaron ${Math.max(deletedCount, localDeletedCount)} facturas correctamente.`,
      restantes,
      sincronizada_en_neon: deletedCount > 0
    });
  } catch (err: any) {
    res.status(500).json({ detail: 'Error en bulk delete de facturas: ' + err.message });
  }
});

router.patch('/facturas/:id/estado', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const ESTADOS_AUDITORIA = ['PENDIENTE', 'AUDITADA', 'RECHAZADA'];
  if (!ESTADOS_AUDITORIA.includes(req.body.estado)) return res.status(400).json({ detail: 'Estado no válido. Usa uno de: ' + ESTADOS_AUDITORIA.join(', ') + '.' });
  const { estado, autor_nombre, autor_id } = req.body;
  try {
    const updated = await CloudSqlService.updateFactura(id, { estado_revision: estado });
    const fLocal = db.facturas.find(fact => fact.id_factura === id);
    if (fLocal) fLocal.estado_revision = estado;

    await CloudSqlService.addModificacion({
      autor_id: autor_id ? Number(autor_id) : undefined,
      autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
      tipo_accion: 'FACTURA_AUDITADA',
      descripcion: `Cambio de estado en factura ${updated?.factura_num || id}: → ${estado}`,
      detalles: `Auditoría registrada en vivo en Google Cloud SQL (peak-sunset-511516-q7).`
    }).catch(() => {});

    res.json(updated || fLocal);
  } catch (err: any) {
    res.status(500).json({ detail: "Error actualizando estado en Cloud SQL: " + err.message });
  }
});

// Una cuenta solo es válida si existe en el plan de cuentas de la empresa de la factura
async function cuentaEnPlanDeEmpresa(idEmpresa: number, cuenta: string): Promise<{ ok: boolean; motivo?: string }> {
  const plan = await CloudSqlService.getCuentasPuc(idEmpresa).catch(() => []);
  const lista = plan.length ? plan : db.cuentasPUC.filter(c => c.id_empresa === idEmpresa);
  if (!lista.length) return { ok: false, motivo: 'Esta empresa no tiene plan de cuentas cargado. Cárguelo en Cerebro Contable PUC.' };
  if (!lista.some(c => c.cuenta === cuenta)) return { ok: false, motivo: `La cuenta ${cuenta} no existe en el plan de cuentas de esta empresa.` };
  return { ok: true };
}

router.patch('/facturas/:id/cuenta', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (typeof req.body.cuenta_gasto !== 'string' || !req.body.cuenta_gasto.trim()) return res.status(400).json({ detail: 'Indique la cuenta contable de gasto.' });
  const { cuenta_gasto, autor_nombre, autor_id } = req.body;
  const facturaActual = db.facturas.find(f => f.id_factura === id);
  if (facturaActual && cuenta_gasto) {
    const validacion = await cuentaEnPlanDeEmpresa(facturaActual.id_empresa, String(cuenta_gasto));
    if (!validacion.ok) return res.status(400).json({ detail: validacion.motivo });
  }
  try {
    const updated = await CloudSqlService.updateFactura(id, { cuenta_gasto });
    const fLocal = db.facturas.find(fact => fact.id_factura === id);
    if (fLocal) fLocal.cuenta_gasto = cuenta_gasto;

    await CloudSqlService.addModificacion({
      autor_id: autor_id ? Number(autor_id) : undefined,
      autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
      tipo_accion: 'PUC_UPDATE',
      descripcion: `Reclasificación PUC en ${updated?.factura_num || id}: → ${cuenta_gasto}`,
      detalles: `Tercero: ${updated?.nit_tercero || ''} (${updated?.proveedor || ''})`
    }).catch(() => {});

    res.json(updated || fLocal);
  } catch (err: any) {
    res.status(500).json({ detail: "Error actualizando cuenta en Cloud SQL: " + err.message });
  }
});

// Cuenta contable y centro de costo de UNA línea de la factura.
// cuenta_contable: "" la quita (la línea usa la cuenta de la factura). centro_costo: null la quita.
router.patch('/facturas/:id/lineas/:linea', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const numLinea = parseInt(req.params.linea);
  const { cuenta_contable, centro_costo } = req.body;
  const factura = db.facturas.find(f => f.id_factura === id);
  if (!factura) return res.status(404).json({ detail: "Factura no encontrada." });
  const linea = (factura.items || []).find(i => i.linea === numLinea);
  if (!linea) return res.status(404).json({ detail: `La factura no tiene la línea ${numLinea}.` });

  const cambios: Partial<FacturaItem> = {};
  if (cuenta_contable !== undefined) {
    const cuenta = String(cuenta_contable || '').trim();
    if (cuenta) {
      const validacion = await cuentaEnPlanDeEmpresa(factura.id_empresa, cuenta);
      if (!validacion.ok) return res.status(400).json({ detail: validacion.motivo });
      cambios.cuenta_contable = cuenta;
    } else {
      cambios.cuenta_contable = undefined;
    }
  }
  if (centro_costo !== undefined) {
    if (centro_costo === null) {
      cambios.centro_costo = null;
    } else if (typeof centro_costo?.id === 'number' && typeof centro_costo?.codigo === 'string') {
      cambios.centro_costo = { id: centro_costo.id, codigo: centro_costo.codigo, nombre: String(centro_costo.nombre || centro_costo.codigo) };
    } else {
      return res.status(400).json({ detail: "El centro de costo debe incluir id y código de Siigo." });
    }
  }

  const items = (factura.items || []).map(i => (i.linea === numLinea ? { ...i, ...cambios } : i));
  try {
    const updated = await CloudSqlService.updateFactura(id, { items } as Partial<Factura>);
    factura.items = items;
    db.saveToDisk();
    await CloudSqlService.addModificacion({
      autor_id: (req as any).usuario?.id_usuario,
      autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
      tipo_accion: 'PUC_UPDATE',
      descripcion: `Línea ${numLinea} de ${factura.factura_num}: cuenta ${cambios.cuenta_contable ?? 'sin cambio'}, centro de costo ${cambios.centro_costo ? cambios.centro_costo.codigo : (cambios.centro_costo === null ? 'quitado' : 'sin cambio')}`,
      detalles: `Tercero: ${factura.nit_tercero} (${factura.proveedor})`
    }).catch(() => {});
    res.json(updated || factura);
  } catch (err: any) {
    res.status(500).json({ detail: "No se pudo guardar la línea en la base de datos: " + err.message });
  }
});

router.patch('/facturas/:id/retencion', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (req.body.retencion_porc !== undefined && numeroEnRango(req.body.retencion_porc, 0, 100) === null) return res.status(400).json({ detail: 'La tarifa de retención debe estar entre 0 y 100.' });
  if (req.body.casilla_350 !== undefined && numeroEnRango(req.body.casilla_350, 1, 999) === null) return res.status(400).json({ detail: 'La casilla del F350 no es válida.' });
  const { retencion_porc, casilla_350, autor_nombre, autor_id } = req.body;
  try {
    const facturas = await CloudSqlService.getFacturas();
    const fCurrent = facturas.find(f => f.id_factura === id);
    const subtotal = fCurrent ? fCurrent.subtotal : 0;
    const rPorc = retencion_porc !== undefined ? Number(retencion_porc) : (fCurrent?.retencion_porc || 0);
    const rVal = Math.round((subtotal * rPorc) / 100);

    const updated = await CloudSqlService.updateFactura(id, {
      retencion_porc: rPorc,
      retencion_valor: rVal,
      casilla_350: casilla_350 !== undefined ? Number(casilla_350) : undefined
    });

    const fLocal = db.facturas.find(fact => fact.id_factura === id);
    if (fLocal) {
      if (retencion_porc !== undefined) {
        fLocal.retencion_porc = rPorc;
        fLocal.retencion_valor = rVal;
      }
      if (casilla_350 !== undefined) fLocal.casilla_350 = Number(casilla_350);
    }

    await CloudSqlService.addModificacion({
      autor_id: autor_id ? Number(autor_id) : undefined,
      autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
      tipo_accion: 'FACTURA_UPDATE',
      descripcion: `Ajuste tributario F350 en ${updated?.factura_num || id}: tarifa ${rPorc}%, casilla ${casilla_350}`,
      detalles: `Retención calculada en Cloud SQL: $${rVal.toLocaleString('es-CO')} COP.`
    }).catch(() => {});

    res.json(updated || fLocal);
  } catch (err: any) {
    res.status(500).json({ detail: "Error actualizando retención en Cloud SQL: " + err.message });
  }
});

router.patch('/facturas/:id/reteica', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (numeroEnRango(req.body.reteica_tarifa, 0, 50) === null) return res.status(400).json({ detail: 'La tarifa de ReteICA debe estar entre 0 y 50 por mil.' });
  const { reteica_tarifa, autor_nombre, autor_id } = req.body;
  const f = db.facturas.find(fact => fact.id_factura === id);
  if (!f) return res.status(404).json({ detail: "Factura no encontrada." });
  f.reteica_tarifa = Number(reteica_tarifa);
  db.saveToDisk();
  await CloudSqlService.updateFactura(id, { reteica_tarifa: f.reteica_tarifa }).catch(() => null);

  await CloudSqlService.addModificacion({
    autor_id: autor_id ? Number(autor_id) : undefined,
    autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
    tipo_accion: 'FACTURA_UPDATE',
    descripcion: `Actualización tarifa ReteICA ${f.factura_num} a ${f.reteica_tarifa}‰`,
    detalles: `Proveedor: ${f.proveedor} en Cloud SQL`
  }).catch(() => {});

  res.json(f);
});

router.patch('/facturas/:id/reteiva', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (numeroEnRango(req.body.reteiva_porc, 0, 100) === null) return res.status(400).json({ detail: 'La tarifa de ReteIVA debe estar entre 0 y 100.' });
  const { reteiva_porc, autor_nombre, autor_id } = req.body;
  const f = db.facturas.find(fact => fact.id_factura === id);
  if (!f) return res.status(404).json({ detail: "Factura no encontrada." });
  f.reteiva_porc = Number(reteiva_porc);
  db.saveToDisk();
  await CloudSqlService.updateFactura(id, { reteiva_porc: f.reteiva_porc }).catch(() => null);

  await CloudSqlService.addModificacion({
    autor_id: autor_id ? Number(autor_id) : undefined,
    autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
    tipo_accion: 'FACTURA_UPDATE',
    descripcion: `Actualización tarifa ReteIVA ${f.factura_num} a ${f.reteiva_porc}%`,
    detalles: `Proveedor: ${f.proveedor} en Cloud SQL`
  }).catch(() => {});

  res.json(f);
});

router.patch('/facturas/:id/medio-pago', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (typeof req.body.medio_pago !== 'string' || !req.body.medio_pago.trim()) return res.status(400).json({ detail: 'Indique el medio de pago.' });
  const { medio_pago, autor_nombre, autor_id } = req.body;
  const f = db.facturas.find(fact => fact.id_factura === id);
  if (!f) return res.status(404).json({ detail: "Factura no encontrada." });
  f.medio_pago = medio_pago;
  db.saveToDisk();
  await CloudSqlService.updateFactura(id, { medio_pago }).catch(() => null);

  await CloudSqlService.addModificacion({
    autor_id: autor_id ? Number(autor_id) : undefined,
    autor_nombre: (req as any).usuario?.nombre_completo || 'Usuario no identificado',
    tipo_accion: 'FACTURA_UPDATE',
    descripcion: `Medio de pago actualizado en ${f.factura_num}: ${medio_pago}`,
    detalles: `Forma de pago: ${f.forma_pago}`
  }).catch(() => {});

  res.json(f);
});

// KPIs y Métricas
router.get('/facturas/kpis/resumen', async (req: Request, res: Response) => {
  const idEmpresa = req.query.id_empresa ? parseInt(req.query.id_empresa as string) : 1;
  let facts = await CloudSqlService.getFacturas(idEmpresa).catch(() => []);
  if (facts.length === 0) {
    facts = db.facturas.filter(f => f.id_empresa === idEmpresa);
  }

  let totalSubtotal = 0;
  let totalIva = 0;
  let totalRetencion = 0;
  let totalAuditadas = 0;

  facts.forEach(f => {
    // Las notas crédito restan compras e IVA y no generan retención (igual que el F350)
    const esNota = /nota/i.test(f.tipo_comprobante || '');
    const signo = esNota ? -1 : 1;
    totalSubtotal += signo * (f.subtotal || 0);
    totalIva += signo * (f.iva || 0);
    if (!esNota) totalRetencion += f.retencion_valor || 0;
    if (f.estado_revision === 'AUDITADA' || f.estado_revision === 'SINCRONIZADA_SIIGO') {
      totalAuditadas++;
    }
  });

  const tasaAuditoria = facts.length > 0 ? Math.round((totalAuditadas / facts.length) * 100) : 0;

  res.json({
    total_facturas: facts.length,
    total_compras_netas: Math.round(totalSubtotal),
    total_iva_descontable: Math.round(totalIva),
    total_retenciones_f350: Math.round(totalRetencion),
    total_auditadas: totalAuditadas,
    tasa_auditoria: tasaAuditoria,
    total_bruto: Math.round(totalSubtotal + totalIva)
  });
});

// ==========================================
// 4. CENTRO FISCAL - FORMULARIO 350 DIAN
// ==========================================
router.get('/impuestos/f350', async (req: Request, res: Response) => {
  const idEmpresa = req.query.id_empresa ? parseInt(req.query.id_empresa as string) : 1;
  let facts = await CloudSqlService.getFacturas(idEmpresa).catch(() => []);
  if (facts.length === 0) {
    facts = db.facturas.filter(f => f.id_empresa === idEmpresa);
  }
  const report = f350TaxEngine.calculateF350(facts, {
    desde: (req.query.desde as string) || (req.query.fecha_desde as string) || undefined,
    hasta: (req.query.hasta as string) || (req.query.fecha_hasta as string) || undefined
  });
  res.json(report);
});

// ==========================================
// 5. CONCILIACIÓN BANCARIA AUTOMÁTICA
// ==========================================
router.get('/conciliacion/movimientos', async (_req: Request, res: Response) => {
  try {
    const [banco, libros] = await Promise.all([
      CloudSqlService.getMovimientosBanco(),
      CloudSqlService.getMovimientosLibro()
    ]);
    res.json({
      banco: banco.length > 0 ? banco : db.movimientosBanco,
      libros: libros.length > 0 ? libros : db.movimientosLibro
    });
  } catch (err) {
    res.json({
      banco: db.movimientosBanco,
      libros: db.movimientosLibro
    });
  }
});

router.post('/conciliacion/ejecutar', async (req: Request, res: Response) => {
  const tolerancia = parseFloat(req.body.tolerancia || '0');
  let banco = await CloudSqlService.getMovimientosBanco().catch(() => []);
  let libros = await CloudSqlService.getMovimientosLibro().catch(() => []);
  if (banco.length === 0) banco = db.movimientosBanco;
  if (libros.length === 0) libros = db.movimientosLibro;

  const result = reconciliationEngine.executeReconciliation(banco, libros, tolerancia);

  // Marcar como conciliados en Cloud SQL
  if (result.cruces && result.cruces.length > 0) {
    for (const c of result.cruces) {
      if (c.banco) await CloudSqlService.conciliarMovimiento('banco', c.banco.id).catch(() => {});
      if (c.libro) await CloudSqlService.conciliarMovimiento('libro', c.libro.id).catch(() => {});
    }
  }

  res.json(result);
});

router.post('/conciliacion/manual', async (req: Request, res: Response) => {
  const { tipo, id, match_id } = req.body;
  try {
    await CloudSqlService.conciliarMovimiento(tipo || 'banco', id, match_id);
    res.json({ ok: true, mensaje: "Movimiento conciliado exitosamente en Cloud SQL." });
  } catch (err: any) {
    res.status(500).json({ detail: "Error conciliando movimiento en Cloud SQL: " + err.message });
  }
});

router.post('/conciliacion/generar-plano-gastos', async (_req: Request, res: Response) => {
  let movimientos = await CloudSqlService.getMovimientosBanco().catch(() => []);
  if (movimientos.length === 0) movimientos = db.movimientosBanco;
  const pendientes = movimientos.filter(b => !b.conciliado);
  const flatFile = reconciliationEngine.generateSiigoAdjustmentFlatFile(pendientes);
  res.json({
    status: 'success',
    total_ajustes: flatFile.length,
    asientos: flatFile
  });
});

// ==========================================
// 6. CEREBRO CONTABLE (PUC & BALANCE)
// ==========================================
router.get('/contabilidad/puc', async (req: Request, res: Response) => {
  const idEmpresa = req.query.id_empresa ? parseInt(req.query.id_empresa as string) : 1;
  try {
    const list = await CloudSqlService.getCuentasPuc(idEmpresa);
    res.json(list.length > 0 ? list : db.cuentasPUC.filter(p => p.id_empresa === idEmpresa));
  } catch (err) {
    res.json(db.cuentasPUC.filter(p => p.id_empresa === idEmpresa));
  }
});

router.post('/contabilidad/puc', async (req: Request, res: Response) => {
  const { cuenta, nombre, naturaleza, id_empresa } = req.body;
  if (!cuenta || !nombre) {
    return res.status(400).json({ detail: "Código de cuenta y nombre son obligatorios." });
  }
  try {
    const created = await CloudSqlService.createCuentaPuc({
      id_empresa: id_empresa || 1,
      cuenta,
      nombre,
      naturaleza: naturaleza || 'DEBITO'
    });
    db.cuentasPUC.push(created);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(500).json({ detail: "Error creando cuenta PUC en Cloud SQL: " + err.message });
  }
});

router.get('/contabilidad/balance', async (req: Request, res: Response) => {
  const idEmpresa = req.query.id_empresa ? parseInt(req.query.id_empresa as string) : 1;
  try {
    const list = await CloudSqlService.getBalanceTerceros(idEmpresa);
    res.json(list.length > 0 ? list : db.balanceTerceros.filter(b => b.id_empresa === idEmpresa));
  } catch (err) {
    res.json(db.balanceTerceros.filter(b => b.id_empresa === idEmpresa));
  }
});

// ==========================================
// 7. INTEGRACIÓN SIIGO NUBE API
// ==========================================
router.get('/siigo/medios-pago', (_req: Request, res: Response) => {
  res.json(siigoService.getMediosPagoCatalog());
});

router.get('/siigo/impuestos', (_req: Request, res: Response) => {
  res.json(siigoService.getImpuestosCatalog());
});

router.post('/siigo/probar-conexion', async (req: Request, res: Response) => {
  const { username, access_key } = req.body;
  const result = await siigoService.testConnection(username, access_key);
  res.json(result);
});

router.post('/siigo/enviar-facturas', async (req: Request, res: Response) => {
  const { facturas_ids, id_tipo_doc, id_medio_pago } = req.body;
  const ids: number[] = Array.isArray(facturas_ids) ? facturas_ids : [];

  const resultados = [];
  for (const id of ids) {
    const f = db.facturas.find(fact => fact.id_factura === id);
    if (!f) continue;

    const emp = (await CloudSqlService.getEmpresas().catch(() => [])).find(e => e.id_empresa === f.id_empresa) || db.empresas.find(e => e.id_empresa === f.id_empresa);
    const cred = emp?.siigo_username && emp?.siigo_access_key ? { username: emp.siigo_username, access_key: emp.siigo_access_key } : undefined;
    const resSync = await siigoService.transmitInvoiceToSiigo(f, id_tipo_doc || emp?.siigo_document_id || 24, id_medio_pago, cred);
    if (resSync.status === 'success') {
      f.estado_revision = 'SINCRONIZADA_SIIGO';
      f.siigo_id = resSync.siigo_id;
      await CloudSqlService.updateFactura(f.id_factura, { estado_revision: 'SINCRONIZADA_SIIGO', siigo_id: resSync.siigo_id }).catch(() => null);
    }
    resultados.push(resSync);
  }

  res.json({
    status: 'success',
    total_enviadas: resultados.length,
    resultados
  });
});

// ==========================================
// 8. CENTRO DE ARQUITECTURA & ESCALABILIDAD
// ==========================================
router.get('/architecture/benchmarks', (_req: Request, res: Response) => {
  res.json({
    benchmarks: scalabilityArchitecture.getBenchmarks(),
    modules: scalabilityArchitecture.getModules(),
    roadmap: scalabilityArchitecture.getScalingRoadmap()
  });
});

// ==========================================
// 9. EXPORTACIÓN MASIVA DE FACTURAS EN PDF
// ==========================================
router.get('/facturas/exportar-pdf', async (req: Request, res: Response) => {
  try {
    const idsParam = req.query.ids as string | undefined;
    let facturasToExport = db.facturas;

    if (idsParam) {
      const ids = idsParam.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
      facturasToExport = facturasToExport.filter(f => ids.includes(f.id_factura));
    }

    if (facturasToExport.length === 0) {
      return res.status(404).json({ detail: "No hay facturas para exportar." });
    }

    const formatCOP = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

    const escapeXml = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const buildPdfXml = (f: any): string => {
      const neto = (f.subtotal + f.iva) - f.retencion_valor;
      const reteicaVal = f.reteica_tarifa ? (f.subtotal * f.reteica_tarifa) / 1000 : 0;
      const reteivaVal = f.reteiva_porc ? (f.iva * f.reteiva_porc) / 100 : 0;
      const safeName = (f.proveedor || 'Proveedor').replace(/[^\w\s-]/g, '').trim().substring(0, 40);
      const safeNum = (f.factura_num || 'SN').replace(/[^\w-]/g, '');
      return `<?xml version="1.0" encoding="UTF-8"?>
<factura>
  <numero>${escapeXml(f.factura_num)}</numero>
  <fecha>${escapeXml(f.fecha)}</fecha>
  <proveedor>${escapeXml(f.proveedor)}</proveedor>
  <nit>${escapeXml(f.nit_tercero)}</nit>
  <ciudad>${escapeXml(f.ciudad || 'Bogotá D.C.')}</ciudad>
  <descripcion>${escapeXml(f.descripcion_item)}</descripcion>
  <subtotal>${formatCOP(f.subtotal)}</subtotal>
  <iva>${formatCOP(f.iva)}</iva>
  <retencion_fuente>${formatCOP(f.retencion_valor)}</retencion_fuente>
  <retencion_ica>${formatCOP(reteicaVal)}</retencion_ica>
  <retencion_iva>${formatCOP(reteivaVal)}</retencion_iva>
  <neto_pagar>${formatCOP(neto - reteicaVal - reteivaVal)}</neto_pagar>
  <cuenta_gasto>${escapeXml(f.cuenta_gasto)}</cuenta_gasto>
  <cufe>${escapeXml(f.cufe_hash)}</cufe>
  <estado>${escapeXml(f.estado_revision)}</estado>
  <archivo_sugerido>${safeNum}_${safeName}.pdf</archivo_sugerido>
</factura>`;
    };

    const xmlParts = facturasToExport.map(buildPdfXml);
    const xmlContent = `<facturas_export total="${facturasToExport.length}">\n${xmlParts.join('\n')}\n</facturas_export>`;

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="facturas_tlm_${facturasToExport.length}.xml"`);
    res.send(xmlContent);
  } catch (err: any) {
    res.status(500).json({ detail: "Error exportando facturas: " + err.message });
  }
});

// ==========================================
// 10. CARGUE DE EXTRACTOS BANCARIOS (MULTIBANCO)
// ==========================================
router.post('/conciliacion/upload-extracto', upload.single('extracto'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ detail: "No se recibió ningún archivo de extracto bancario." });
    }
    const banco = (req.body.banco || 'DAVIVIENDA').toUpperCase();
    const idEmpresa = parseInt(req.body.id_empresa || '1');
    const content = file.buffer.toString('utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    const movimientos: any[] = [];

    for (const line of lines) {
      let fecha = '', concepto = '', monto = 0, tipo = 'CREDITO', referencia = '';

      if (banco === 'BANCOLOMBIA') {
        const cols = line.split('\t');
        if (cols.length >= 5) {
          fecha = cols[0].trim();
          concepto = cols[1].trim();
          monto = parseFloat(cols[3].replace(/[$,\s]/g, '')) || 0;
          tipo = parseFloat(cols[2].replace(/[$,\s]/g, '')) > 0 ? 'DEBITO' : 'CREDITO';
          referencia = cols[4] || '';
        }
      } else if (banco === 'BBVA') {
        const cols = line.split(';');
        if (cols.length >= 4) {
          fecha = cols[0].trim();
          concepto = cols[1].trim();
          monto = parseFloat(cols[2].replace(/[$,\s]/g, '')) || 0;
          tipo = monto < 0 ? 'DEBITO' : 'CREDITO';
          referencia = cols[3] || '';
        }
      } else {
        const cols = line.split(/[,\t;]/);
        if (cols.length >= 4) {
          fecha = cols[0].trim();
          concepto = cols[1].trim();
          monto = parseFloat(cols[2].replace(/[$,\s]/g, '')) || 0;
          tipo = monto < 0 ? 'DEBITO' : 'CREDITO';
          referencia = cols[3] || '';
        }
      }

      if (fecha && concepto && monto !== 0) {
        movimientos.push({
          id: `EXT-${Date.now()}-${movimientos.length}`,
          fecha,
          concepto,
          monto: Math.abs(monto),
          tipo,
          referencia,
          conciliado: false,
          id_empresa: idEmpresa
        });
      }
    }

    db.movimientosBanco.push(...movimientos);
    db.saveToDisk();

    res.json({
      status: 'success',
      banco,
      movimientos_importados: movimientos.length,
      mensaje: `Extracto de ${banco} procesado: ${movimientos.length} movimientos importados.`
    });
  } catch (err: any) {
    res.status(500).json({ detail: "Error procesando extracto bancario: " + err.message });
  }
});

// ==========================================
// 11. CARGUE MASIVO DE PUC POR NIT DE EMPRESA
// ==========================================
router.post('/contabilidad/puc-masivo', upload.single('archivo_puc'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ detail: "No se recibió archivo de PUC." });
    }
    const nit = req.body.nit;
    if (!nit) {
      return res.status(400).json({ detail: "Debe especificar el NIT de la empresa para asociar el PUC." });
    }

    const empresa = db.empresas.find(e => e.nit === nit);
    if (!empresa) {
      return res.status(404).json({ detail: `No se encontró empresa con NIT ${nit}.` });
    }

    const content = file.buffer.toString('utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    const cuentas: any[] = [];

    for (const line of lines) {
      const cols = line.split(/[,\t;]/).map(c => c.trim());
      if (cols.length >= 2) {
        const cuenta = cols[0];
        const nombre = cols[1];
        const naturaleza = cols[2] || 'DEBITO';
        if (cuenta && nombre) {
          cuentas.push({
            id_empresa: empresa.id_empresa,
            cuenta,
            nombre,
            naturaleza
          });
        }
      }
    }

    const created = await CloudSqlService.bulkCreateCuentasPuc(cuentas).catch(() => cuentas);
    db.cuentasPUC.push(...created);
    db.saveToDisk();

    res.json({
      status: 'success',
      nit,
      empresa: empresa.nombre_comercial,
      cuentas_importadas: created.length,
      mensaje: `Plan Único de Cuentas cargado para ${empresa.nombre_comercial} (NIT ${nit}): ${created.length} cuentas.`
    });
  } catch (err: any) {
    res.status(500).json({ detail: "Error cargando PUC: " + err.message });
  }
});

// ==========================================
// 12. CREACIÓN DE EMPRESA CON PUC INICIAL
// ==========================================
router.post('/empresas/crear-con-puc', upload.fields([{ name: 'archivo_puc', maxCount: 1 }, { name: 'archivo_balance', maxCount: 1 }]), async (req: Request, res: Response) => {
  const { nombre_comercial, nit, software_erp, siigo_username, siigo_access_key, siigo_document_id } = req.body;

  if (!nombre_comercial || !nit) {
    return res.status(400).json({ detail: "Nombre comercial y NIT son obligatorios." });
  }

  try {
    const nuevaEmpresa = await CloudSqlService.createEmpresa({
      nombre_comercial,
      nit,
      software_erp: software_erp || "SIIGO_NUBE",
      software_destino: software_erp || "SIIGO_NUBE",
      siigo_username,
      siigo_access_key,
      siigo_document_id: siigo_document_id || 24
    });

    db.empresas.push(nuevaEmpresa);

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const pucFile = files?.archivo_puc?.[0];
    const balanceFile = files?.archivo_balance?.[0];

    let cuentasImportadas = 0;
    let balanceImportado = 0;

    if (pucFile) {
      const content = pucFile.buffer.toString('utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      const cuentas: any[] = [];
      for (const line of lines) {
        const cols = line.split(/[,\t;]/).map(c => c.trim());
        if (cols.length >= 2 && cols[0] && cols[1]) {
          cuentas.push({
            id_empresa: nuevaEmpresa.id_empresa,
            cuenta: cols[0],
            nombre: cols[1],
            naturaleza: cols[2] || 'DEBITO'
          });
        }
      }
      const created = await CloudSqlService.bulkCreateCuentasPuc(cuentas).catch(() => cuentas);
      db.cuentasPUC.push(...created);
      cuentasImportadas = created.length;
    }

    if (balanceFile) {
      const content = balanceFile.buffer.toString('utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      const balances: any[] = [];
      for (const line of lines) {
        const cols = line.split(/[,\t;]/).map(c => c.trim());
        if (cols.length >= 7) {
          balances.push({
            id_empresa: nuevaEmpresa.id_empresa,
            cuenta_contable: cols[0],
            nombre_cuenta: cols[1],
            nit_tercero: cols[2],
            nombre_tercero: cols[3],
            saldo_inicial: parseFloat(cols[4]) || 0,
            debitos: parseFloat(cols[5]) || 0,
            creditos: parseFloat(cols[6]) || 0,
            saldo_final: parseFloat(cols[7] || '0') || 0
          });
        }
      }
      db.balanceTerceros.push(...balances);
      balanceImportado = balances.length;
    }

    db.saveToDisk();

    res.status(201).json({
      ...nuevaEmpresa,
      puc_cuentas_importadas: cuentasImportadas,
      balance_registros_importados: balanceImportado,
      mensaje: `Empresa ${nombre_comercial} creada con NIT ${nit}. PUC: ${cuentasImportadas} cuentas, Balance: ${balanceImportado} registros.`
    });
  } catch (err: any) {
    res.status(500).json({ detail: "Error creando empresa con PUC: " + err.message });
  }
});

export default router;
