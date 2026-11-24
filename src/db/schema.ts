import { pgTable, serial, bigserial, text, integer, boolean, numeric, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

// 1. Usuarios & Autenticación (con soporte para Firebase Auth UID & IAM)
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').unique(), // Firebase UID opcional o generado
  email: text('email').notNull().unique(),
  nombreCompleto: text('nombre_completo').notNull(),
  hashedPassword: text('hashed_password'),
  rol: text('rol').notNull().default('Analista'), // Administrador, Contador, Analista, Auditor
  activo: boolean('activo').notNull().default(true),
  empresasIds: integer('empresas_ids').array().default([1]),
  requiereCambioPassword: boolean('requiere_cambio_password').default(false),
  permisos: jsonb('permisos').default({}),
  avatarUrl: text('avatar_url'),
  verificationToken: text('verification_token'),
  tokenExpiresAt: timestamp('token_expires_at'),
  emailVerified: boolean('email_verified').default(true),
  codigoRecuperacion: text('codigo_recuperacion'),
  codigoRecuperacionExpira: timestamp('codigo_recuperacion_expira'),
  intentosCodigo: integer('intentos_codigo').default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

// 2. Empresas (Multi-Tenant & Credenciales Siigo Nube)
export const empresas = pgTable('empresas', {
  id: serial('id').primaryKey(),
  nombreComercial: text('nombre_comercial').notNull(),
  nit: text('nit').notNull().unique(),
  softwareErp: text('software_erp').default('SIIGO_NUBE'),
  softwareDestino: text('software_destino').default('SIIGO_NUBE'),
  siigoUsername: text('siigo_username'),
  siigoAccessKey: text('siigo_access_key'),
  siigoDocumentId: integer('siigo_document_id').default(24),
  logoUrl: text('logo_url'),
  createdAt: timestamp('created_at').defaultNow(),
});

// 3. Facturas DIAN (UBL 2.1, CUFEs & Retenciones F350)
export const facturas = pgTable('facturas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  idEmpresa: integer('id_empresa').default(1),
  facturaNum: text('factura_num').notNull(),
  proveedor: text('proveedor').notNull(),
  nitTercero: text('nit_tercero').notNull(),
  fecha: text('fecha').notNull(),
  fechaVencimiento: text('fecha_vencimiento'),
  tipoComprobante: text('tipo_comprobante').default('Factura Electrónica'),
  descripcionItem: text('descripcion_item').notNull(),
  cantidad: numeric('cantidad').default('1'),
  valorUnitario: numeric('valor_unitario').default('0'),
  subtotal: numeric('subtotal').notNull().default('0'),
  iva: numeric('iva').notNull().default('0'),
  retencionPorc: numeric('retencion_porc').default('0'),
  retencionValor: numeric('retencion_valor').default('0'),
  total: numeric('total').default('0'),
  estadoRevision: text('estado_revision').default('PENDIENTE'), // PENDIENTE, AUDITADA, RECHAZADA, SINCRONIZADA_SIIGO
  cufeHash: text('cufe_hash'),
  casilla350: integer('casilla_350').default(83),
  formaPago: text('forma_pago').default('Crédito'),
  medioPago: text('medio_pago').default('Transferencia Débito'),
  cuentaGasto: text('cuenta_gasto').default('513535'),
  estadoSiigo: text('estado_siigo').default('PENDIENTE'),
  fechaCargue: text('fecha_cargue'),
  // Campos ampliados (venta/compra, tercero completo, líneas UBL y parámetros Siigo)
  tipoOperacion: text('tipo_operacion').default('COMPRA'),
  telefono: text('telefono'),
  direccion: text('direccion'),
  ciudad: text('ciudad'),
  departamento: text('departamento'),
  correo: text('correo'),
  reteicaTarifa: numeric('reteica_tarifa').default('0'),
  reteivaPorc: numeric('reteiva_porc').default('0'),
  bancoSiigo: text('banco_siigo'),
  siigoId: text('siigo_id'),
  idMedioPago: integer('id_medio_pago'),
  idRetencion: integer('id_retencion'),
  idReteica: integer('id_reteica'),
  idReteiva: integer('id_reteiva'),
  items: jsonb('items'),
  datosUbl: jsonb('datos_ubl'),
  createdAt: timestamp('created_at').defaultNow(),
}, table => [
  uniqueIndex('facturas_id_empresa_cufe_hash_key').on(table.idEmpresa, table.cufeHash),
]);

// 4. Cuentas PUC (Plan Único de Cuentas)
export const cuentasPuc = pgTable('cuentas_puc', {
  id: serial('id').primaryKey(),
  idEmpresa: integer('id_empresa').default(1),
  cuenta: text('cuenta').notNull(),
  nombre: text('nombre').notNull(),
  naturaleza: text('naturaleza').default('DEBITO'),
});

// 5. Balance por Terceros (Saldos Contables)
export const balanceTerceros = pgTable('balance_terceros', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  idEmpresa: integer('id_empresa').default(1),
  cuentaContable: text('cuenta_contable').notNull(),
  nombreCuenta: text('nombre_cuenta').notNull(),
  nitTercero: text('nit_tercero').notNull(),
  nombreTercero: text('nombre_tercero').notNull(),
  saldoInicial: numeric('saldo_inicial').default('0'),
  debitos: numeric('debitos').default('0'),
  creditos: numeric('creditos').default('0'),
  saldoFinal: numeric('saldo_final').default('0'),
});

// 6. Movimientos Banco (Extractos Bancarios)
export const movimientosBanco = pgTable('movimientos_banco', {
  id: text('id').primaryKey(),
  fecha: text('fecha').notNull(),
  concepto: text('concepto').notNull(),
  monto: numeric('monto').notNull(),
  tipo: text('tipo').notNull(), // DEBITO, CREDITO
  saldo: numeric('saldo').default('0'),
  referencia: text('referencia'),
  conciliado: boolean('conciliado').default(false),
});

// 7. Movimientos Libro (Libro Mayor Contable ERP)
export const movimientosLibro = pgTable('movimientos_libro', {
  id: text('id').primaryKey(),
  fecha: text('fecha').notNull(),
  concepto: text('concepto').notNull(),
  monto: numeric('monto').notNull(),
  tipo: text('tipo').notNull(), // DEBITO, CREDITO
  cuenta: text('cuenta').notNull(),
  tercero: text('tercero'),
  conciliado: boolean('conciliado').default(false),
});

// 8. Modificaciones Repositorio (Historial de Auditoría & Commits v2.0)
export const modificacionesRepositorio = pgTable('modificaciones_repositorio', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull(),
  autorId: integer('autor_id').default(1),
  autorNombre: text('autor_nombre').notNull(),
  autorEmail: text('autor_email'),
  autorRol: text('autor_rol'),
  tipoAccion: text('tipo_accion').notNull(),
  descripcion: text('descripcion').notNull(),
  detalles: text('detalles'),
  versionDestino: text('version_destino').default('v2.0'),
  repositorio: text('repositorio').default('Repositorio Central de Juan Yaya'),
  hashCommit: text('hash_commit'),
});
