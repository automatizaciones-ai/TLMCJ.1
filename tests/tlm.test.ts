import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

// Cada ejecución trabaja en un directorio temporal: no toca data/tlm_database.json real.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-test-'));
process.chdir(workDir);
process.env.SESSION_SECRET = 'test-secret-para-pruebas';
process.env.NODE_ENV = 'development';

// Servidor SMTP de prueba: guarda cada correo recibido en memoria
const correos: string[] = [];
const sink = net.createServer(sock => {
  let buf = '';
  let enDatos = false;
  let datos = '';
  sock.write('220 sink ESMTP\r\n');
  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\r\n')) !== -1) {
      const linea = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (enDatos) {
        if (linea === '.') {
          enDatos = false;
          correos.push(datos);
          datos = '';
          sock.write('250 OK\r\n');
        } else {
          datos += linea + '\n';
        }
        continue;
      }
      const cmd = linea.toUpperCase();
      if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) sock.write('250 sink\r\n');
      else if (cmd === 'DATA') { enDatos = true; sock.write('354 OK\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
  sock.on('error', () => undefined);
});

let base = '';
let closeServer: () => void = () => undefined;
let hashPassword: (p: string) => string;
let verifyPassword: (p: string, s: string) => boolean;
let attempts: typeof import('../src/server/services/attemptLimiter.ts');

beforeAll(async () => {
  await new Promise<void>(r => sink.listen(0, '127.0.0.1', () => r()));
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String((sink.address() as net.AddressInfo).port);
  process.env.SMTP_FROM = 'Consola TLM <no-reply@tlm.net.co>';

  // Imports dinámicos: el correo y la base leen el entorno al cargarse
  const express = (await import('express')).default;
  const apiRouter = (await import('../src/server/routes/apiRouter.ts')).default;
  // Igual que server.ts: no se atiende nada hasta que los datos estén cargados
  const { db } = await import('../src/server/storage/dataStore.ts');
  await db.ready;
  const pw = await import('../src/server/services/passwordHasher.ts');
  hashPassword = pw.hashPassword;
  verifyPassword = pw.verifyPassword;
  attempts = await import('../src/server/services/attemptLimiter.ts');

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // Igual que server.ts: crea las tablas y carga los datos de Cloud SQL antes de atender peticiones
  const { CloudSqlService } = await import('../src/server/services/cloudSqlService.ts');
  await CloudSqlService.initAndSeed().catch(() => null);
  await CloudSqlService.syncCloudSqlToDataStore(db).catch(() => null);

  // Igual que server.ts: sesión obligatoria antes de los routers
  const { guardarApi } = await import('../src/server/services/sessionAuth.ts');
  app.use('/api/v1', guardarApi);
  app.use('/api/v1', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api/v1`;
  closeServer = () => server.close();
});

afterAll(() => {
  closeServer();
  sink.close();
});

// ---------- utilidades ----------
async function api(p: string, opts: { method?: string; body?: unknown; cookie?: string; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + p, { method: opts.method || 'GET', headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function loginCon(email: string, password: string) {
  return api('/auth/login', { method: 'POST', body: { email, password } });
}

// Quita la codificación quoted-printable para poder buscar texto con acentos
const decodificar = (c: string) => c.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

async function esperarCorreo(destinatario: string, fragmento: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const found = [...correos].reverse().find(c => c.includes(`To: ${destinatario}`) && decodificar(c).includes(fragmento));
    if (found) return decodificar(found);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`No llegó correo a ${destinatario} con "${fragmento}"`);
}

const codigoDe = (correo: string) => {
  const m = decodificar(correo).match(/es: (\d{6})/);
  if (!m) throw new Error('El correo no trae código');
  return m[1];
};

const xmlFactura = (num: string, lineas: number[], opts: { root?: string; descripcion?: string; nit?: string } = {}) => {
  const root = opts.root || 'Invoice';
  const subtotal = lineas.reduce((a, b) => a + b, 0);
  const lines = lineas.map((v, i) => `
  <cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:LineExtensionAmount currencyID="COP">${v}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>${opts.descripcion || 'Servicio de mantenimiento'} ${i + 1}</cbc:Description></cac:Item></cac:InvoiceLine>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>${num}</cbc:ID>
  <cbc:UUID>cufe-${num}-${subtotal}</cbc:UUID>
  <cbc:IssueDate>2026-03-10</cbc:IssueDate>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme>
    <cbc:RegistrationName>Proveedor Demo SAS</cbc:RegistrationName>
    <cbc:CompanyID>${opts.nit || '900123456'}</cbc:CompanyID>
  </cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="COP">${Math.round(subtotal * 0.19)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="COP">${Math.round(subtotal * 0.19)}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>01</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>${lines}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="COP">${subtotal}</cbc:LineExtensionAmount>
    <cbc:PayableAmount currencyID="COP">${subtotal + Math.round(subtotal * 0.19)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</${root}>`;
};

async function subirXml(nombre: string, contenido: string) {
  const form = new FormData();
  form.append('id_empresa', '1');
  form.append('archivos', new Blob([contenido], { type: 'text/xml' }), nombre);
  return api('/facturas/upload', { method: 'POST', form, cookie: sesionAdmin });
}

let sesionAdmin = '';

// ---------- 1. Unitarias: contraseñas y límite de intentos ----------
describe('contraseñas (scrypt)', () => {
  test('hash verifica la clave correcta y rechaza la incorrecta', async () => {
    const h = hashPassword('Clave2026x');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('Clave2026x', h)).toBe(true);
    expect(verifyPassword('Clave2026y', h)).toBe(false);
  });

  test('dos hashes de la misma clave son distintos (sal aleatoria)', () => {
    expect(hashPassword('Clave2026x')).not.toBe(hashPassword('Clave2026x'));
  });
});

describe('límite de intentos', () => {
  test('bloquea tras el máximo de fallos y desbloquea al limpiar', () => {
    const k = 'prueba-unitaria';
    for (let i = 0; i < 3; i++) attempts.recordFailure(k, 3, 60_000, 60_000);
    expect(attempts.secondsLocked(k)).toBeGreaterThan(0);
    attempts.clearAttempts(k);
    expect(attempts.secondsLocked(k)).toBe(0);
  });

  test('no bloquea antes del máximo', () => {
    const k = 'prueba-unitaria-2';
    attempts.recordFailure(k, 3, 60_000, 60_000);
    attempts.recordFailure(k, 3, 60_000, 60_000);
    expect(attempts.secondsLocked(k)).toBe(0);
  });
});

// ---------- 2. Autenticación y control de acceso ----------
describe('autenticación', () => {
  test('sin sesión la API responde 401', async () => {
    expect((await api('/empresas')).status).toBe(401);
    expect((await api('/facturas')).status).toBe(401);
  });

  test('login sin contraseña es rechazado', async () => {
    const r = await api('/auth/login', { method: 'POST', body: { email: 'automatizaciones@tlm.net.co' } });
    expect(r.status).toBe(401);
  });

  test('contraseñas universales antiguas ya no entran', async () => {
    expect((await loginCon('automatizaciones@tlm.net.co', 'admin123')).status).toBe(401);
  });

  test('login del administrador entrega cookie httpOnly y sesión válida', async () => {
    const r = await loginCon('automatizaciones@tlm.net.co', 'admin_hashed_token');
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toContain('HttpOnly');
    sesionAdmin = r.cookie;
    const s = await api('/auth/sesion', { cookie: sesionAdmin });
    expect(s.status).toBe(200);
    expect(s.json.hashed_password).toBeUndefined();
  });

  test('cookie alterada es rechazada', async () => {
    const r = await api('/empresas', { cookie: 'tlm_session=1.99999999999999.firma-falsa' });
    expect(r.status).toBe(401);
  });

  test('una cuenta con 5 contraseñas malas queda bloqueada, incluso con la correcta', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await loginCon('maria.gomez@tlm.net.co', 'mala')).status).toBe(401);
    }
    const sexto = await loginCon('maria.gomez@tlm.net.co', 'contador_hash');
    expect(sexto.status).toBe(429);
    expect(Number(sexto.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('usuario normal no ve notificaciones de seguridad ni cambia usuarios (403)', async () => {
    const r = await loginCon('carlos.analista@tlm.net.co', 'analista_hash');
    expect(r.status).toBe(200);
    const carlos = r.cookie;
    expect((await api('/auth/notificaciones-seguridad', { cookie: carlos })).status).toBe(403);
    expect((await api('/auth/usuarios/5/toggle-admin', { method: 'PATCH', cookie: carlos })).status).toBe(403);
    expect((await api('/auth/usuarios/5', { method: 'DELETE', cookie: carlos })).status).toBe(403);
  });

  test('listado de usuarios no expone hashes ni códigos', async () => {
    const r = await api('/auth/usuarios', { cookie: sesionAdmin });
    expect(r.status).toBe(200);
    for (const u of r.json) {
      expect(u.hashed_password).toBeUndefined();
      expect(u.codigo_recuperacion).toBeUndefined();
    }
  });

  test('cambiar contraseña exige sesión y la clave actual correcta', async () => {
    expect((await api('/auth/cambiar-password', { method: 'POST', body: { nueva_password: 'Nueva2026x', confirmar_password: 'Nueva2026x' } })).status).toBe(401);
    const carlos = (await loginCon('carlos.analista@tlm.net.co', 'analista_hash')).cookie;
    const mala = await api('/auth/cambiar-password', { method: 'POST', cookie: carlos, body: { password_actual: 'otra', nueva_password: 'Nueva2026x', confirmar_password: 'Nueva2026x' } });
    expect(mala.status).toBe(401);
  });

  test('registro sin contraseña es rechazado', async () => {
    const r = await api('/auth/register', { method: 'POST', body: { nombre_completo: 'Nuevo', email: 'nuevo@tlm.net.co' } });
    expect(r.status).toBe(400);
  });
});

// ---------- 3. Recuperación de contraseña por correo ----------
describe('recuperación por correo', () => {
  test('código por correo: cooldown, verificación con bloqueo y cambio correcto', async () => {
    const email = 'valentina.castro@tlm.net.co';
    const r = await api('/auth/recuperar-password/solicitar-codigo', { method: 'POST', body: { email } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toMatch(/codigo_simulado|\b\d{6}\b/);

    const again = await api('/auth/recuperar-password/solicitar-codigo', { method: 'POST', body: { email } });
    expect(again.status).toBe(429);

    const codigo = codigoDe(await esperarCorreo(email, 'Expira en 15'));
    const malo =await api('/auth/recuperar-password/verificar-y-cambiar', { method: 'POST', body: { email, codigo: codigo === '000000' ? '111111' : '000000', nueva_password: 'Recuperada2026', confirmar_password: 'Recuperada2026' } });
    expect(malo.status).toBe(400);

    const ok = await api('/auth/recuperar-password/verificar-y-cambiar', { method: 'POST', body: { email, codigo, nueva_password: 'Recuperada2026', confirmar_password: 'Recuperada2026' } });
    expect(ok.status).toBe(200);
    expect((await loginCon(email, 'Recuperada2026')).status).toBe(200);
    expect((await loginCon(email, 'Recuperada2026x')).status).toBe(401);
  });

  test('cuenta inexistente recibe la misma respuesta y no se envía correo', async () => {
    const antes = correos.length;
    const r = await api('/auth/recuperar-password/solicitar-codigo', { method: 'POST', body: { email: 'nadie@tlm.net.co' } });
    expect(r.status).toBe(200);
    await new Promise(r => setTimeout(r, 200));
    expect(correos.length).toBe(antes);
  });

  test('tras 5 códigos incorrectos la verificación queda bloqueada', async () => {
    const email = 'carlos.analista@tlm.net.co';
    await api('/auth/recuperar-password/solicitar-codigo', { method: 'POST', body: { email } });
    const codigo = codigoDe(await esperarCorreo(email, 'Expira en 15'));
    const erroneo = codigo === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await api('/auth/recuperar-password/verificar-y-cambiar', { method: 'POST', body: { email, codigo: erroneo, nueva_password: 'Otra2026x', confirmar_password: 'Otra2026x' } });
    }
    const bloqueado = await api('/auth/recuperar-password/verificar-y-cambiar', { method: 'POST', body: { email, codigo, nueva_password: 'Otra2026x', confirmar_password: 'Otra2026x' } });
    expect(bloqueado.status).toBe(429);
  });

  test('los códigos no aparecen en las notificaciones del administrador', async () => {
    const r = await api('/auth/notificaciones-seguridad', { cookie: sesionAdmin });
    const codigos = correos.map(c => codigoDe(c)).filter(Boolean);
    for (const c of codigos) expect(JSON.stringify(r.json)).not.toContain(c);
  });
});

// ---------- 4. Administración de usuarios ----------
describe('administración de usuarios', () => {
  test('crear usuario envía la clave provisional por correo y no la devuelve', async () => {
    const r = await api('/auth/usuarios/crear-por-admin', {
      method: 'POST', cookie: sesionAdmin,
      body: { nombre_completo: 'Nueva Persona', email: 'nueva.persona@tlm.net.co', rol: 'Analista', password_provisional: 'Provisional2026', empresas_ids: [1] }
    });
    expect(r.status).toBe(201);
    expect(r.json.correo_enviado).toBe(true);
    expect(r.json.password_provisional).toBeUndefined();
    const correo = await esperarCorreo('nueva.persona@tlm.net.co', 'provisional');
    expect(correo).toContain('Provisional2026');
    expect((await loginCon('nueva.persona@tlm.net.co', 'Provisional2026')).status).toBe(200);
  });
});

// ---------- 5. Módulos de negocio ----------
describe('empresas', () => {
  test('listar, crear y actualizar', async () => {
    const lista = await api('/empresas', { cookie: sesionAdmin });
    expect(lista.status).toBe(200);
    expect(Array.isArray(lista.json)).toBe(true);
    expect(lista.json.length).toBeGreaterThan(0);

    const nueva = await api('/empresas', { method: 'POST', cookie: sesionAdmin, body: { nombre_comercial: 'Empresa Prueba SAS', nit: '901111111' } });
    expect([200, 201]).toContain(nueva.status);
    expect(nueva.json.nombre_comercial).toBe('Empresa Prueba SAS');
    const creada = (await api('/empresas', { cookie: sesionAdmin })).json.find((e: any) => e.nit === '901111111');
    expect(creada).toBeDefined();

    const ids = (await api('/empresas', { cookie: sesionAdmin })).json.map((e: any) => e.id_empresa);
    expect(new Set(ids).size).toBe(ids.length);

    const conClave = await api('/empresas', { method: 'POST', cookie: sesionAdmin, body: { nombre_comercial: 'Con Clave', nit: '901222222', siigo_access_key: 'SECRETO-123' } });
    const listaEmp = await api('/empresas', { cookie: sesionAdmin });
    expect(JSON.stringify(listaEmp.json)).not.toContain('SECRETO-123');
    expect(conClave.status).toBeLessThan(300);
    expect(JSON.stringify(conClave.json)).not.toContain('SECRETO-123');
  });
});

describe('facturas XML (UBL)', () => {
  test('lee más de 100 XML y ZIP anidado sin límite fijo, incluidas notas crédito', async () => {
    const zip = new JSZip();
    for (let i = 1; i <= 120; i++) {
      zip.file(`documentos/FE-${i}.xml`, xmlFactura(`FE-ZIP-${i}`, [1000], { root: i === 120 ? 'CreditNote' : 'Invoice' }));
    }

    let archivoAnidado = new JSZip();
    archivoAnidado.file('FE-anidada.xml', xmlFactura('FE-ZIP-ANIDADA', [2000]));
    let bufferAnidado = await archivoAnidado.generateAsync({ type: 'nodebuffer' });
    for (let i = 0; i < 3; i++) {
      const contenedor = new JSZip();
      contenedor.file(`nivel-${i}.zip`, bufferAnidado);
      bufferAnidado = await contenedor.generateAsync({ type: 'nodebuffer' });
    }
    zip.file('archivo-anidado.zip', bufferAnidado);

    const { xmlParser } = await import('../src/server/services/xmlUblParser.ts');
    const rutaZip = path.join(workDir, 'lote-masivo.zip');
    fs.writeFileSync(rutaZip, await zip.generateAsync({ type: 'nodebuffer' }));
    const documentos = await xmlParser.parseFilePath(rutaZip, 'lote-masivo.zip');
    expect(documentos).toHaveLength(121);
    expect(documentos.find(d => d.factura_num === 'FE-ZIP-120')?.tipo_comprobante).toBe('Nota de Crédito');
    expect(documentos.some(d => d.factura_num === 'FE-ZIP-ANIDADA')).toBe(true);
  });

  test('subtotal toma el total de cabecera, no la primera línea', async () => {
    const r = await subirXml('FE-1001.xml', xmlFactura('FE-1001', [1000000, 1000000]));
    expect(r.status).toBeLessThan(300);
    const lista = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    const f = lista.json.find((x: any) => x.factura_num === 'FE-1001');
    expect(f).toBeDefined();
    expect(f.subtotal).toBe(2000000);
    expect(f.iva).toBe(380000);
    expect(f.total).toBe(2380000);
  });

  test('subir el mismo XML dos veces no duplica la factura', async () => {
    await subirXml('FE-1001.xml', xmlFactura('FE-1001', [1000000, 1000000]));
    const lista = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    expect(lista.json.filter((x: any) => x.factura_num === 'FE-1001').length).toBe(1);
  });

  test('un XML incompleto se rechaza y no inventa datos', async () => {
    const r = await subirXml('malo.xml', '<Invoice><cbc:ID>MALO-1</cbc:ID></Invoice>');
    const lista = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    expect(lista.json.some((x: any) => x.factura_num === 'MALO-1')).toBe(false);
    expect(r.json?.facturas_creadas ?? 0).toBe(0);
  });

  test('ids de factura únicos aunque se borre una y se suba otra', async () => {
    // Se borra una factura creada solo para la prueba, sin tocar FE-1001 que usan otras pruebas
    await subirXml('BORRAR-1.xml', xmlFactura('BORRAR-1', [100000]));
    const lista = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    const borrar = lista.json.find((x: any) => x.factura_num === 'BORRAR-1');
    await api(`/facturas/${borrar.id_factura}`, { method: 'DELETE', cookie: sesionAdmin });
    await subirXml('FE-2001.xml', xmlFactura('FE-2001', [500000]));
    const despues = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    const ids = despues.json.map((x: any) => x.id_factura);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('KPI de compras netas resta las notas crédito', async () => {
    await subirXml('NC-1.xml', xmlFactura('NC-1', [300000], { root: 'CreditNote' }));
    const lista = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    const nc = lista.json.find((x: any) => x.factura_num === 'NC-1');
    expect(nc.tipo_comprobante).toMatch(/nota/i);
    const compras = lista.json.filter((x: any) => !/nota/i.test(x.tipo_comprobante)).reduce((a: number, f: any) => a + f.subtotal, 0);
    const notas = lista.json.filter((x: any) => /nota/i.test(x.tipo_comprobante)).reduce((a: number, f: any) => a + f.subtotal, 0);
    const kpi = await api('/facturas/kpis/resumen?id_empresa=1', { cookie: sesionAdmin });
    expect(kpi.json.total_compras_netas).toBe(Math.round(compras - notas));
    expect(kpi.json.total_facturas).toBe(lista.json.length);
  });
});

describe('impuestos F350', () => {
  test('bases, retenciones y gran total cuadran con las facturas', async () => {
    const r = await api('/impuestos/f350?id_empresa=1', { cookie: sesionAdmin });
    expect(r.status).toBe(200);
    const d = r.json;
    expect(d.granTotalRetenido).toBe(d.totalRetenciones + d.totalReteIva + d.totalReteIca);
    const sumaCasillas = d.casillas.reduce((a: number, c: any) => a + c.retencion_calculada, 0);
    expect(Math.abs(sumaCasillas - (d.totalRetenciones + d.totalReteIva))).toBeLessThanOrEqual(d.casillas.length);
  });

  test('el año gravable sale de los datos, no está fijo', async () => {
    const r = await api('/impuestos/f350?id_empresa=1', { cookie: sesionAdmin });
    expect(r.json.anoGravable).toBe(2026);
    expect(r.json.periodo).toContain('2026');
  });
});

describe('conciliación bancaria', () => {
  test('partidas conciliadas + pendientes igualan los movimientos', async () => {
    const mov = await api('/conciliacion/movimientos', { cookie: sesionAdmin });
    const r = await api('/conciliacion/ejecutar', { method: 'POST', cookie: sesionAdmin, body: { tolerancia: 0 } });
    expect(r.status).toBe(200);
    expect(r.json.partidasConciliadas + r.json.partidasPendientesBanco).toBe(mov.json.banco.length);
    expect(r.json.partidasConciliadas + r.json.partidasPendientesLibros).toBe(mov.json.libros.length);
    expect(r.json.tasaCoincidencia).toBeGreaterThanOrEqual(0);
    expect(r.json.tasaCoincidencia).toBeLessThanOrEqual(100);
  });
});

describe('contabilidad', () => {
  test('PUC y balance de terceros responden con listas', async () => {
    const puc = await api('/contabilidad/puc?id_empresa=1', { cookie: sesionAdmin });
    const bal = await api('/contabilidad/balance?id_empresa=1', { cookie: sesionAdmin });
    expect(Array.isArray(puc.json)).toBe(true);
    expect(Array.isArray(bal.json)).toBe(true);
    expect(puc.json.length).toBeGreaterThan(0);
  });
});

describe('integración Siigo', () => {
  test('el envío no se presenta como sincronización real ni marca la factura', async () => {
    const lista = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    const f = lista.json.find((x: any) => x.factura_num === 'FE-1001');
    const r = await api('/siigo/enviar-facturas', { method: 'POST', cookie: sesionAdmin, body: { facturas_ids: [f.id_factura] } });
    expect(r.status).toBe(200);
    const resultado = r.json.resultados ? r.json.resultados[0] : r.json[0];
    // Sin credenciales de Siigo no puede haber un envío exitoso falso
    expect(resultado.status).not.toBe('success');
    const despues = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    const f2 = despues.json.find((x: any) => x.factura_num === 'FE-1001');
    expect(f2.estado_revision).not.toBe('SINCRONIZADA_SIIGO');
  });
});

describe('seguridad de exportaciones', () => {
  test('respaldo y repositorio no incluyen hashes ni códigos', async () => {
    const backup = await fetch(base + '/sistema/export-backup', { headers: { cookie: sesionAdmin } }).then(r => r.text());
    expect(backup).not.toContain('hashed_password');
    expect(backup).not.toContain('codigo_recuperacion');
    const repo = await api('/repositorio/juan', { cookie: sesionAdmin });
    expect(JSON.stringify(repo.json)).not.toContain('hashed_password');
  });
});

describe('módulos de lectura', () => {
  test('información del sistema, arquitectura y siigo catálogos responden', async () => {
    expect((await api('/sistema/database-info', { cookie: sesionAdmin })).status).toBe(200);
    expect((await api('/architecture/benchmarks', { cookie: sesionAdmin })).status).toBe(200);
    expect((await api('/siigo/medios-pago', { cookie: sesionAdmin })).status).toBe(200);
    expect((await api('/siigo/impuestos', { cookie: sesionAdmin })).status).toBe(200);
  });
});

describe('facturas: estados y validaciones de edición', () => {
  let fId = 0;
  let subtotal = 0;
  beforeAll(async () => {
    const lista = await api('/facturas?id_empresa=1', { cookie: sesionAdmin });
    const f = lista.json.find((x: any) => x.factura_num === 'FE-1001');
    fId = f.id_factura;
    subtotal = f.subtotal;
  });

  test('estado fuera de la lista se rechaza y SINCRONIZADA_SIIGO no se puede fijar a mano', async () => {
    const malo = await api(`/facturas/${fId}/estado`, { method: 'PATCH', cookie: sesionAdmin, body: { estado: 'INVENTADO' } });
    expect(malo.status).toBe(400);
    const sync = await api(`/facturas/${fId}/estado`, { method: 'PATCH', cookie: sesionAdmin, body: { estado: 'SINCRONIZADA_SIIGO' } });
    expect(sync.status).toBe(400);
  });

  test('estado válido se guarda y queda en la bitácora con el autor de la sesión', async () => {
    const ok = await api(`/facturas/${fId}/estado`, { method: 'PATCH', cookie: sesionAdmin, body: { estado: 'AUDITADA' } });
    expect(ok.status).toBe(200);
    expect(ok.json.estado_revision).toBe('AUDITADA');
  });

  test('porcentajes fuera de rango o no numéricos se rechazan (sin NaN guardado)', async () => {
    expect((await api(`/facturas/${fId}/retencion`, { method: 'PATCH', cookie: sesionAdmin, body: { retencion_porc: 'abc' } })).status).toBe(400);
    expect((await api(`/facturas/${fId}/retencion`, { method: 'PATCH', cookie: sesionAdmin, body: { retencion_porc: 150 } })).status).toBe(400);
    expect((await api(`/facturas/${fId}/reteiva`, { method: 'PATCH', cookie: sesionAdmin, body: { reteiva_porc: 'x' } })).status).toBe(400);
    expect((await api(`/facturas/${fId}/reteica`, { method: 'PATCH', cookie: sesionAdmin, body: { reteica_tarifa: 999 } })).status).toBe(400);
  });

  test('retención válida recalcula el valor sobre el subtotal', async () => {
    const r = await api(`/facturas/${fId}/retencion`, { method: 'PATCH', cookie: sesionAdmin, body: { retencion_porc: 4 } });
    expect(r.status).toBe(200);
    expect(r.json.retencion_valor).toBe(Math.round((subtotal * 4) / 100));
  });

  test('medio de pago y cuenta vacíos se rechazan', async () => {
    expect((await api(`/facturas/${fId}/medio-pago`, { method: 'PATCH', cookie: sesionAdmin, body: { medio_pago: '  ' } })).status).toBe(400);
    expect((await api(`/facturas/${fId}/cuenta`, { method: 'PATCH', cookie: sesionAdmin, body: {} })).status).toBe(400);
  });
});

describe('auditoría', () => {
  test('no se puede falsificar el autor de una modificación', async () => {
    const r = await api('/repositorio/juan/modificacion', {
      method: 'POST', cookie: sesionAdmin,
      body: { descripcion: 'Prueba de autoría', autor_nombre: 'Hacker', autor_email: 'otro@x.com', autor_rol: 'Administrador' }
    });
    expect(r.status).toBe(201);
    expect(r.json.modificacion.autor_nombre).not.toBe('Hacker');
    expect(r.json.modificacion.autor_email).toBe('automatizaciones@tlm.net.co');
  });
});

describe('administración de usuarios: acciones', () => {
  test('cambiar rol, permisos, empresas y activación', async () => {
    const id = 6; // Valentina
    const rol = await api(`/auth/usuarios/${id}/rol`, { method: 'PATCH', cookie: sesionAdmin, body: { rol: 'Auditor' } });
    expect(rol.status).toBe(200);
    expect(rol.json.usuario.rol).toBe('Auditor');

    const emp = await api(`/auth/usuarios/${id}/empresas`, { method: 'PATCH', cookie: sesionAdmin, body: { empresas_ids: [1] } });
    expect(emp.status).toBe(200);
    expect(emp.json.usuario.empresas_ids).toEqual([1]);

    const apagar = await api(`/auth/usuarios/${id}/toggle-activo`, { method: 'PATCH', cookie: sesionAdmin });
    expect(apagar.status).toBe(200);
    const bloqueado = await loginCon('valentina.castro@tlm.net.co', 'Recuperada2026');
    expect(bloqueado.status).toBe(403);
    await api(`/auth/usuarios/${id}/toggle-activo`, { method: 'PATCH', cookie: sesionAdmin });
    expect((await loginCon('valentina.castro@tlm.net.co', 'Recuperada2026')).status).toBe(200);
  });

  test('borrar usuario lo quita del listado', async () => {
    const lista = await api('/auth/usuarios', { cookie: sesionAdmin });
    const nueva = lista.json.find((u: any) => u.email === 'nueva.persona@tlm.net.co');
    const r = await api(`/auth/usuarios/${nueva.id_usuario}`, { method: 'DELETE', cookie: sesionAdmin });
    expect(r.status).toBe(200);
    const despues = await api('/auth/usuarios', { cookie: sesionAdmin });
    expect(despues.json.some((u: any) => u.email === 'nueva.persona@tlm.net.co')).toBe(false);
  });
});

describe('integraciones: sin fingir conexión', () => {
  test('Google Cloud informa que no está conectado y no registra sincronización falsa', async () => {
    const st = await api('/sistema/google-cloud-status', { cookie: sesionAdmin });
    expect(st.json.conectado).toBe(false);
    const antes = (await api('/repositorio/juan', { cookie: sesionAdmin })).json.modificaciones.length;
    const sync = await api('/sistema/google-cloud-sync', { method: 'POST', cookie: sesionAdmin, body: {} });
    expect(sync.status).toBe(501);
    const despues = (await api('/repositorio/juan', { cookie: sesionAdmin })).json.modificaciones.length;
    expect(despues).toBe(antes);
  });

  test('configuración Siigo guarda la clave pero no la devuelve completa', async () => {
    const r = await api('/empresas/1/siigo-config', { method: 'PUT', cookie: sesionAdmin, body: { siigo_username: 'demo', siigo_access_key: 'CLAVE-REAL-999', validar: false } });
    expect(r.status).toBe(200);
    const cfg = await api('/empresas/1/siigo-config', { cookie: sesionAdmin });
    expect(JSON.stringify(cfg.json)).not.toContain('CLAVE-REAL-999');
  });
});

describe('coherencia contable', () => {
  test('saldo final respeta la naturaleza de cada cuenta (activos y gastos débito; pasivos, patrimonio e ingresos crédito)', async () => {
    const bal = await api('/contabilidad/balance?id_empresa=1', { cookie: sesionAdmin });
    const deudora = (cuenta: string) => ['1', '5', '6', '7'].includes(cuenta[0]);
    for (const b of bal.json) {
      const esperado = deudora(b.cuenta_contable)
        ? b.saldo_inicial + b.debitos - b.creditos
        : b.saldo_inicial + b.creditos - b.debitos;
      expect(Math.abs(b.saldo_final - esperado)).toBeLessThanOrEqual(1);
    }
  });

  test('las cuentas del PUC no se repiten dentro de una empresa', async () => {
    const puc = await api('/contabilidad/puc?id_empresa=1', { cookie: sesionAdmin });
    const cuentas = puc.json.map((c: any) => c.cuenta);
    expect(new Set(cuentas).size).toBe(cuentas.length);
  });
});

describe('arranque en producción', () => {
  const storeFile = path.join(import.meta.dir, '../src/server/storage/dataStore.ts');
  const script = `(async () => {
    const { db } = await import(${JSON.stringify(storeFile)});
    await db.ready;
    console.log('USUARIOS=' + JSON.stringify(db.usuarios.map(u => u.email)));
    console.log('FACTURAS=' + db.facturas.length);
  })().catch(e => { console.error(e.message); process.exit(1); });`;

  const correrEnProduccion = (extra: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-prod-'));
    const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', ADMIN_PASSWORD: '', ADMIN_EMAIL: '', ...extra };
    return Bun.spawnSync(['bun', '-e', script], { cwd: dir, env });
  };

  test('sin ADMIN_PASSWORD no arranca y explica qué falta', () => {
    const r = correrEnProduccion({});
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('ADMIN_PASSWORD');
  });

  test('con ADMIN_PASSWORD solo existe el administrador, sin cuentas de demostración', () => {
    const r = correrEnProduccion({ ADMIN_PASSWORD: 'Admin2026x', ADMIN_EMAIL: 'Jefe@TLM.net.co' });
    expect(r.exitCode).toBe(0);
    const linea = r.stdout.toString().split('\n').find(l => l.startsWith('USUARIOS='))!;
    expect(JSON.parse(linea.slice('USUARIOS='.length))).toEqual(['jefe@tlm.net.co']);
    expect(r.stdout.toString()).toContain('FACTURAS=0');
  });
});

// Va al final: bloquea la IP de pruebas para todos los inicios de sesión posteriores
describe('límite por IP', () => {
  test('muchos fallos desde una misma IP bloquean el inicio de sesión', async () => {
    let bloqueado = false;
    for (let i = 0; i < 40 && !bloqueado; i++) {
      const r = await loginCon(`intruso${i}@tlm.net.co`, 'x');
      if (r.status === 429) bloqueado = true;
    }
    expect(bloqueado).toBe(true);
  });
});
