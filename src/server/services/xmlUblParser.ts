import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import * as yauzl from 'yauzl';
import JSZip from 'jszip';

export interface ParteUbl {
  nit: string;
  dv?: string;
  tipo_documento?: string;
  razon_social: string;
  nombre_comercial?: string;
  tipo_contribuyente?: string;
  regimen_fiscal?: string;
  responsabilidad_tributaria?: string;
  direccion?: string;
  ciudad?: string;
  departamento?: string;
  pais?: string;
  telefono?: string;
  correo?: string;
}

export interface LineaUbl {
  linea: number;
  codigo?: string;
  descripcion_item: string;
  unidad?: string;
  cantidad: number;
  valor_unitario: number;
  descuento: number;
  subtotal: number;
  iva: number;
  iva_porc: number;
  inc: number;
}

export interface ParsedXmlInvoice {
  factura_num: string;
  fecha: string;
  fecha_vencimiento?: string;
  /** VENTA si el emisor es la empresa activa, COMPRA en cualquier otro caso */
  tipo_operacion: 'VENTA' | 'COMPRA';
  /** Contraparte: cliente (en ventas) o proveedor (en compras). Se conserva el nombre "proveedor" por compatibilidad. */
  proveedor: string;
  nit_tercero: string;
  telefono?: string;
  direccion?: string;
  ciudad?: string;
  departamento?: string;
  correo?: string;
  descripcion_item: string;
  cantidad: number;
  valor_unitario: number;
  subtotal: number;
  iva: number;
  total?: number;
  casilla_350: number;
  retencion_porc: number;
  retencion_valor: number;
  reteica_tarifa: number;
  reteiva_porc: number;
  forma_pago: string;
  medio_pago: string;
  cuenta_gasto: string;
  tipo_comprobante: string;
  cufe_hash: string;
  estado_revision: 'PENDIENTE' | 'AUDITADA';
  items: LineaUbl[];
  /** PDF de la representación gráfica que venía en el mismo paquete (.zip) que el XML */
  pdf_original?: { nombre: string; contenido: Buffer };
  datos_ubl: {
    emisor: ParteUbl;
    adquiriente: ParteUbl;
    tipo_operacion_dian?: string;
    moneda?: string;
    orden_pedido?: string;
    archivo_origen?: string;
  };
}

const normalizarNombre = (s: string) => (s || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '');

/**
 * Asigna a cada documento el PDF que le corresponde dentro del mismo paquete:
 * 1) mismo nombre de archivo que el XML, 2) el nombre del PDF contiene el número de factura o el inicio del CUFE,
 * 3) si queda un solo PDF y un solo documento sin pareja, se emparejan.
 */
export function emparejarPdfs(facturas: ParsedXmlInvoice[], pdfs: { nombre: string; contenido: Buffer }[]): void {
  if (!facturas.length || !pdfs.length) return;
  const libres = [...pdfs];
  const tomar = (i: number) => libres.splice(i, 1)[0];

  for (const f of facturas) {
    const base = normalizarNombre((f.datos_ubl?.archivo_origen || '').split('/').pop() || '');
    const i = base ? libres.findIndex(p => normalizarNombre(p.nombre) === base) : -1;
    if (i >= 0) f.pdf_original = tomar(i);
  }
  for (const f of facturas.filter(x => !x.pdf_original)) {
    const num = normalizarNombre(f.factura_num);
    const cufe = (f.cufe_hash || '').toLowerCase().substring(0, 16);
    const i = libres.findIndex(p => {
      const n = normalizarNombre(p.nombre);
      return (num.length >= 3 && n.includes(num)) || (cufe.length >= 16 && n.includes(cufe));
    });
    if (i >= 0) f.pdf_original = tomar(i);
  }
  const sinPdf = facturas.filter(x => !x.pdf_original);
  if (sinPdf.length === 1 && libres.length === 1) sinPdf[0].pdf_original = tomar(0);
}

// ==========================================
// Utilidades de lectura de XML por expresiones regulares (rápidas y tolerantes a namespaces)
// ==========================================
const decodificar = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

const etiqueta = (bloque: string, nombre: string): string => {
  const re = new RegExp(`<(?:[\\w-]+:)?${nombre}\\b[^>]*>([^<]*)</(?:[\\w-]+:)?${nombre}>`, 'i');
  const m = bloque.match(re);
  return m ? decodificar(m[1]) : '';
};

const atributo = (bloque: string, nombre: string, attr: string): string => {
  const re = new RegExp(`<(?:[\\w-]+:)?${nombre}\\b[^>]*\\b${attr}="([^"]*)"`, 'i');
  const m = bloque.match(re);
  return m ? m[1] : '';
};

const bloque = (texto: string, nombre: string): string => {
  const re = new RegExp(`<(?:[\\w-]+:)?${nombre}\\b[\\s\\S]*?</(?:[\\w-]+:)?${nombre}>`, 'i');
  const m = texto.match(re);
  return m ? m[0] : '';
};

const bloques = (texto: string, nombre: string): string[] => {
  const re = new RegExp(`<(?:[\\w-]+:)?${nombre}\\b[\\s\\S]*?</(?:[\\w-]+:)?${nombre}>`, 'gi');
  return texto.match(re) || [];
};

const num = (v: string): number => {
  const n = parseFloat((v || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const soloDigitos = (v: string) => (v || '').split('-')[0].replace(/[^\d]/g, '');

const MEDIOS_PAGO: Record<string, string> = {
  '10': 'Efectivo',
  '20': 'Cheque',
  '42': 'Consignación bancaria',
  '47': 'Transferencia Débito',
  '48': 'Tarjeta Crédito',
  '49': 'Tarjeta Débito',
  ZZZ: 'Acuerdo mutuo'
};

const TIPOS_OPERACION: Record<string, string> = {
  '10': '10 - Estándar',
  '09': '09 - AIU',
  '11': '11 - Mandatos',
  '20': '20 - Nota crédito con referencia',
  '22': '22 - Nota crédito sin referencia',
  SS_CUFE: 'SS - Documento soporte'
};

const REGIMEN: Record<string, string> = { '48': 'Responsable de IVA', '49': 'No responsable de IVA' };

function parsearParte(bloqueParte: string): ParteUbl {
  const taxScheme = bloque(bloqueParte, 'PartyTaxScheme') || bloqueParte;
  const legal = bloque(bloqueParte, 'PartyLegalEntity');
  const direccionBloque = bloque(taxScheme, 'RegistrationAddress') || bloque(bloqueParte, 'PhysicalLocation') || bloque(bloqueParte, 'Address');
  const contacto = bloque(bloqueParte, 'Contact');
  const companyIdBloque = taxScheme.match(/<(?:[\w-]+:)?CompanyID\b[^>]*>[^<]*<\//i)?.[0] || legal.match(/<(?:[\w-]+:)?CompanyID\b[^>]*>[^<]*<\//i)?.[0] || '';
  const companyId = etiqueta(taxScheme, 'CompanyID') || etiqueta(legal, 'CompanyID') || etiqueta(bloqueParte, 'ID');
  const tipoOrg = etiqueta(bloqueParte, 'AdditionalAccountID');
  const regimenCodigo = atributo(taxScheme, 'TaxLevelCode', 'listName');

  return {
    nit: soloDigitos(companyId),
    dv: (companyIdBloque.match(/schemeID="(\d)"/i) || [])[1],
    tipo_documento: (companyIdBloque.match(/schemeName="(\d+)"/i) || [])[1] === '31' ? 'NIT' : ((companyIdBloque.match(/schemeName="(\d+)"/i) || [])[1] === '13' ? 'Cédula de ciudadanía' : 'NIT'),
    razon_social: etiqueta(taxScheme, 'RegistrationName') || etiqueta(legal, 'RegistrationName') || etiqueta(bloque(bloqueParte, 'PartyName'), 'Name'),
    nombre_comercial: etiqueta(bloque(bloqueParte, 'PartyName'), 'Name') || undefined,
    tipo_contribuyente: tipoOrg === '1' ? 'Persona Jurídica' : tipoOrg === '2' ? 'Persona Natural' : undefined,
    regimen_fiscal: REGIMEN[regimenCodigo] || (regimenCodigo ? `R-${regimenCodigo}` : undefined),
    responsabilidad_tributaria: etiqueta(taxScheme, 'TaxLevelCode') || undefined,
    direccion: etiqueta(bloque(direccionBloque, 'AddressLine'), 'Line') || undefined,
    ciudad: etiqueta(direccionBloque, 'CityName') || undefined,
    departamento: etiqueta(direccionBloque, 'CountrySubentity') || undefined,
    pais: etiqueta(bloque(direccionBloque, 'Country'), 'Name') || undefined,
    telefono: etiqueta(contacto, 'Telephone') || undefined,
    correo: etiqueta(contacto, 'ElectronicMail') || undefined
  };
}

function parsearLineas(xml: string, esNotaCredito: boolean): LineaUbl[] {
  const nombreLinea = esNotaCredito ? 'CreditNoteLine' : 'InvoiceLine';
  const nombreCantidad = esNotaCredito ? 'CreditedQuantity' : 'InvoicedQuantity';
  return bloques(xml, nombreLinea).map((l, i) => {
    const cantidad = num(etiqueta(l, nombreCantidad)) || 1;
    const subtotal = num(etiqueta(l, 'LineExtensionAmount'));
    const item = bloque(l, 'Item');
    let iva = 0;
    let ivaPorc = 0;
    let inc = 0;
    for (const sub of bloques(l, 'TaxSubtotal')) {
      const id = etiqueta(bloque(sub, 'TaxScheme'), 'ID');
      const monto = num(etiqueta(sub, 'TaxAmount'));
      if (id === '01' || !id) {
        iva += monto;
        ivaPorc = num(etiqueta(sub, 'Percent')) || ivaPorc;
      } else if (id === '04') {
        inc += monto;
      }
    }
    const descuento = bloques(l, 'AllowanceCharge')
      .filter(a => /<(?:[\w-]+:)?ChargeIndicator[^>]*>false</i.test(a))
      .reduce((s, a) => s + num(etiqueta(a, 'Amount')), 0);
    const precio = num(etiqueta(bloque(l, 'Price'), 'PriceAmount')) || (cantidad ? subtotal / cantidad : subtotal);
    return {
      linea: Number(etiqueta(l, 'ID')) || i + 1,
      codigo: etiqueta(bloque(item, 'StandardItemIdentification'), 'ID') || etiqueta(bloque(item, 'SellersItemIdentification'), 'ID') || undefined,
      descripcion_item: etiqueta(item, 'Description') || etiqueta(item, 'Name') || `Ítem ${i + 1}`,
      unidad: atributo(l, nombreCantidad, 'unitCode') || undefined,
      cantidad,
      valor_unitario: precio,
      descuento,
      subtotal,
      iva,
      iva_porc: ivaPorc,
      inc
    };
  });
}

export class XmlUblParserService {
  /**
   * Main entry point for processing uploaded buffers (supports both direct XML and ZIP packages)
   */
  public async parseFileBuffer(buffer: Buffer, fileName: string = "factura.xml", nitEmpresaActiva: string = ""): Promise<ParsedXmlInvoice[]> {
    const isZip = fileName.toLowerCase().endsWith('.zip') ||
                  (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04);

    if (isZip) {
      return this.parseZipBuffer(buffer, fileName, nitEmpresaActiva);
    }

    return this.parseXmlUbl(this.bufferATexto(buffer), fileName, nitEmpresaActiva);
  }

  public async parseFilePath(filePath: string, fileName: string = "factura.xml", nitEmpresaActiva: string = ""): Promise<ParsedXmlInvoice[]> {
    const handle = await fs.promises.open(filePath, 'r');
    let signature: Buffer;
    try {
      signature = Buffer.alloc(4);
      await handle.read(signature, 0, signature.length, 0);
    } finally {
      await handle.close();
    }

    const isZip = fileName.toLowerCase().endsWith('.zip') ||
      (signature[0] === 0x50 && signature[1] === 0x4B && signature[2] === 0x03 && signature[3] === 0x04);
    if (isZip) return this.parseZipFilePath(filePath, fileName, nitEmpresaActiva);

    return this.parseXmlUbl(this.bufferATexto(await fs.promises.readFile(filePath)), fileName, nitEmpresaActiva);
  }

  private async parseZipFilePath(zipPath: string, zipFileName: string, nitEmpresaActiva: string): Promise<ParsedXmlInvoice[]> {
    const results: ParsedXmlInvoice[] = [];
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlm-zip-'));
    const pendientes: { filePath: string; nombre: string }[] = [{ filePath: zipPath, nombre: zipFileName }];
    let nestedIndex = 0;

    try {
      while (pendientes.length) {
        const actual = pendientes.pop()!;
        let zip: yauzl.ZipFile;
        try {
          zip = await yauzl.openPromise(actual.filePath, { lazyEntries: true });
        } catch (err) {
          if (actual.filePath === zipPath) throw err;
          console.warn(`[XML-Parser] No se pudo abrir el ZIP anidado "${actual.nombre}":`, err);
          continue;
        }

        const propios: ParsedXmlInvoice[] = [];
        const pdfs: { nombre: string; contenido: Buffer }[] = [];
        const zipsInternos: { filePath: string; nombre: string }[] = [];

        try {
          for await (const entry of zip.eachEntry()) {
            const lower = entry.fileName.toLowerCase();
            const nombreBase = entry.fileName.split('/').pop() || '';
            if (entry.fileName.endsWith('/') || entry.fileName.includes('__MACOSX') || nombreBase.startsWith('.')) continue;
            const esXml = lower.endsWith('.xml');
            const esPdf = lower.endsWith('.pdf');
            const esZip = lower.endsWith('.zip');
            if (!esXml && !esPdf && !esZip) continue;

            try {
              const stream = await zip.openReadStreamPromise(entry);
              if (esXml) {
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                propios.push(...this.parseXmlUbl(this.bufferATexto(Buffer.concat(chunks)), entry.fileName, nitEmpresaActiva));
              } else if (esPdf) {
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                const contenido = Buffer.concat(chunks);
                if (contenido.subarray(0, 5).toString('latin1') === '%PDF-') pdfs.push({ nombre: nombreBase, contenido });
              } else if (esZip) {
                const filePath = path.join(tempDir, `${nestedIndex++}.zip`);
                await pipeline(stream, fs.createWriteStream(filePath));
                zipsInternos.push({ filePath, nombre: entry.fileName });
              }
            } catch (err) {
              console.warn(`[XML-Parser] Error extrayendo "${entry.fileName}" dentro de ${actual.nombre}:`, err);
            }
          }
        } finally {
          zip.close();
        }

        emparejarPdfs(propios, pdfs);
        results.push(...propios);
        for (let i = zipsInternos.length - 1; i >= 0; i--) pendientes.push(zipsInternos[i]);
        console.log(`[XML-Parser] ZIP "${actual.nombre}": ${propios.length} documentos UBL extraídos.`);
      }
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }

    return results;
  }

  private bufferATexto(buffer: Buffer): string {
    let text = buffer.toString('utf-8');
    if (/encoding=["'](?:ISO-8859-1|latin1|windows-1252)["']/i.test(text.substring(0, 200))) {
      text = buffer.toString('latin1');
    }
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.substring(1);
    }
    return text;
  }

  /**
   * Unpacks a ZIP archive and extracts all contained XML invoices (also nested ZIPs, as sent by many DIAN providers)
   */
  public async parseZipBuffer(zipBuffer: Buffer, zipFileName: string, nitEmpresaActiva: string = ""): Promise<ParsedXmlInvoice[]> {
    const results: ParsedXmlInvoice[] = [];
    const pendientes: { buffer: Buffer; nombre: string }[] = [{ buffer: zipBuffer, nombre: zipFileName }];

    while (pendientes.length) {
      const actual = pendientes.pop()!;
      try {
        const zip = await JSZip.loadAsync(actual.buffer);
        const nombres = Object.keys(zip.files).filter(name => !zip.files[name].dir && !name.includes('__MACOSX') && !name.split('/').pop()!.startsWith('.'));
        const propios: ParsedXmlInvoice[] = [];
        const pdfs: { nombre: string; contenido: Buffer }[] = [];
        const zipsInternos: { buffer: Buffer; nombre: string }[] = [];

        for (const entryName of nombres) {
          const lower = entryName.toLowerCase();
          try {
            if (lower.endsWith('.xml')) {
              const fileData = await zip.files[entryName].async('nodebuffer');
              propios.push(...this.parseXmlUbl(this.bufferATexto(fileData), entryName, nitEmpresaActiva));
            } else if (lower.endsWith('.pdf')) {
              const contenido = await zip.files[entryName].async('nodebuffer');
              if (contenido.subarray(0, 5).toString('latin1') === '%PDF-') pdfs.push({ nombre: entryName.split('/').pop()!, contenido });
            } else if (lower.endsWith('.zip')) {
              const interno = await zip.files[entryName].async('nodebuffer');
              zipsInternos.push({ buffer: interno, nombre: entryName });
            }
          } catch (err) {
            console.warn(`[XML-Parser] Error extrayendo "${entryName}" dentro de ${actual.nombre}:`, err);
          }
        }

        emparejarPdfs(propios, pdfs);
        results.push(...propios);
        for (let i = zipsInternos.length - 1; i >= 0; i--) pendientes.push(zipsInternos[i]);
        console.log(`[XML-Parser] ZIP "${actual.nombre}": ${propios.length} documentos UBL extraídos, ${propios.filter(r => r.pdf_original).length} con PDF original.`);
      } catch (zipErr) {
        console.error(`[XML-Parser] Error leyendo archivo ZIP ${actual.nombre}:`, zipErr);
      }
    }
    return results;
  }

  /**
   * Parse DIAN UBL 2.1 XML content into canonical structured invoice object.
   * Soporta Invoice, CreditNote y el contenedor AttachedDocument (CDATA o base64).
   */
  public parseXmlUbl(rawXmlContent: string, fileName: string = "factura.xml", nitEmpresaActiva: string = ""): ParsedXmlInvoice[] {
    try {
      let xmlContent = rawXmlContent.trim();

      if (/<(?:[\w-]+:)?AttachedDocument\b/i.test(xmlContent)) {
        const cdataMatch = xmlContent.match(/<!\[CDATA\[([\s\S]*?<\/(?:[\w-]+:)?(?:Invoice|CreditNote)>)[\s\S]*?\]\]>/i);
        if (cdataMatch && /<(?:[\w-]+:)?(?:Invoice|CreditNote)\b/.test(cdataMatch[1])) {
          xmlContent = cdataMatch[1].trim();
        } else {
          const base64Match = xmlContent.match(/<(?:cbc:EmbeddedDocumentBinaryObject|cbc:Description)[^>]*>([A-Za-z0-9+/=\r\n]{60,})<\//i);
          if (base64Match) {
            try {
              const decoded = Buffer.from(base64Match[1].replace(/\s+/g, ''), 'base64').toString('utf-8');
              if (decoded.includes('<Invoice') || decoded.includes('<CreditNote')) {
                xmlContent = decoded.trim();
              }
            } catch (e) {}
          }
        }
      }

      // Solo documentos UBL de factura o nota crédito
      if (!/<(?:[\w-]+:)?(?:Invoice|CreditNote)\b/i.test(xmlContent)) {
        return [];
      }

      // Quitar extensiones DIAN y firma para que no contaminen las búsquedas
      const xml = xmlContent
        .replace(/<(?:[\w-]+:)?UBLExtensions\b[\s\S]*?<\/(?:[\w-]+:)?UBLExtensions>/gi, '')
        .replace(/<(?:[\w-]+:)?Signature\b[\s\S]*?<\/(?:[\w-]+:)?Signature>/gi, '');

      const isCreditNote = /<(?:[\w-]+:)?CreditNote\b/i.test(xml);
      const lineasXml = isCreditNote ? 'CreditNoteLine' : 'InvoiceLine';
      const encabezado = xml.replace(new RegExp(`<(?:[\\w-]+:)?${lineasXml}\\b[\\s\\S]*?</(?:[\\w-]+:)?${lineasXml}>`, 'gi'), '');

      // Número y fechas (del encabezado, no de las líneas)
      const sinPartes = encabezado
        .replace(/<(?:[\w-]+:)?AccountingSupplierParty\b[\s\S]*?<\/(?:[\w-]+:)?AccountingSupplierParty>/gi, '')
        .replace(/<(?:[\w-]+:)?AccountingCustomerParty\b[\s\S]*?<\/(?:[\w-]+:)?AccountingCustomerParty>/gi, '');
      let factura_num = etiqueta(sinPartes, 'ID');
      if (!factura_num || factura_num.length > 35 || factura_num.startsWith('http')) {
        factura_num = fileName.split('/').pop()!.replace(/\.[^/.]+$/, '').replace(/[^\w-]/g, '') || `FE-${Date.now()}`;
      }
      const fecha = etiqueta(sinPartes, 'IssueDate') || 'SIN_FECHA';
      const fecha_vencimiento = etiqueta(sinPartes, 'PaymentDueDate') || etiqueta(sinPartes, 'DueDate') || fecha;

      let cufe_hash = etiqueta(sinPartes, 'UUID');
      if (!cufe_hash || cufe_hash.length < 10) {
        cufe_hash = crypto.createHash('sha256').update(rawXmlContent).digest('hex');
      }

      // Partes
      const emisor = parsearParte(bloque(encabezado, 'AccountingSupplierParty'));
      const adquiriente = parsearParte(bloque(encabezado, 'AccountingCustomerParty'));
      const nitEmpresa = soloDigitos(nitEmpresaActiva);
      const tipo_operacion: 'VENTA' | 'COMPRA' = nitEmpresa && emisor.nit === nitEmpresa ? 'VENTA' : 'COMPRA';
      const tercero = tipo_operacion === 'VENTA' ? adquiriente : emisor;

      // Pago
      const pago = bloque(encabezado, 'PaymentMeans');
      const forma_pago = etiqueta(pago, 'ID') === '1' ? 'Contado' : 'Crédito';
      const codigoMedio = etiqueta(pago, 'PaymentMeansCode');
      const medio_pago = MEDIOS_PAGO[codigoMedio] || (codigoMedio ? `Código ${codigoMedio}` : 'Transferencia Débito');

      // Líneas
      const items = parsearLineas(xml, isCreditNote);

      // Totales del encabezado
      const totales = bloque(encabezado, 'LegalMonetaryTotal');
      let subtotalVal = num(etiqueta(totales, 'LineExtensionAmount'));
      let totalVal = num(etiqueta(totales, 'PayableAmount'));
      let ivaVal = bloques(encabezado, 'TaxTotal')
        .filter(t => !/WithholdingTaxTotal/i.test(t))
        .flatMap(t => bloques(t, 'TaxSubtotal'))
        .filter(s => ['01', ''].includes(etiqueta(bloque(s, 'TaxScheme'), 'ID')))
        .reduce((s, sub) => s + num(etiqueta(sub, 'TaxAmount')), 0);

      if (subtotalVal === 0 && items.length) subtotalVal = items.reduce((s, it) => s + it.subtotal, 0);
      if (ivaVal === 0 && items.length) ivaVal = items.reduce((s, it) => s + it.iva, 0);
      // Solo se deriva el subtotal si el XML trae el IVA; nunca se asume una tarifa
      if (subtotalVal === 0 && totalVal > 0 && ivaVal > 0) subtotalVal = totalVal - ivaVal;
      if (totalVal === 0) totalVal = subtotalVal + ivaVal;
      // Sin proveedor ni valores no se inventa nada: la factura se rechaza
      if (!emisor.nit || !emisor.razon_social) throw new Error('La factura no identifica al proveedor (NIT o razón social).');
      if (subtotalVal === 0) throw new Error('La factura no trae el valor del subtotal (LineExtensionAmount).');

      const lineas: LineaUbl[] = items.length
        ? items
        : [{ linea: 1, descripcion_item: 'Bienes y servicios', cantidad: 1, valor_unitario: subtotalVal, descuento: 0, subtotal: subtotalVal, iva: ivaVal, iva_porc: subtotalVal ? Math.round((ivaVal / subtotalVal) * 100) : 0, inc: 0 }];

      const descripcion = lineas.length === 1 ? lineas[0].descripcion_item : `${lineas[0].descripcion_item} (+${lineas.length - 1} ítems)`;
      const cantidadTotal = lineas.reduce((s, l) => s + l.cantidad, 0);

      // Clasificación contable / F350 (solo aplica retención en compras)
      let casilla_350 = 64;
      let retencion_porc = 0;
      let cuenta_gasto = tipo_operacion === 'VENTA' ? '41350101' : '519530';
      if (tipo_operacion === 'COMPRA') {
        const descLower = (lineas.map(l => l.descripcion_item).join(' ') + ' ' + tercero.razon_social).toLowerCase();
        if (/honorario|asesor|consult/.test(descLower)) {
          casilla_350 = 61; retencion_porc = 10.0; cuenta_gasto = '511010';
        } else if (/servicio|mantenimiento|soporte|nube|cloud|licencia/.test(descLower)) {
          casilla_350 = 62; retencion_porc = subtotalVal >= 176000 ? 4.0 : 0.0; cuenta_gasto = '513535';
        } else if (/arriend|canon|inmueble/.test(descLower)) {
          casilla_350 = 63; retencion_porc = 3.5; cuenta_gasto = '512010';
        } else {
          casilla_350 = 64; retencion_porc = subtotalVal >= 1189000 ? 2.5 : 0.0; cuenta_gasto = '519530';
        }
      }
      const retencion_valor = Math.round((subtotalVal * retencion_porc) / 100);
      const signo = isCreditNote ? -1 : 1;

      return [
        {
          factura_num,
          fecha,
          fecha_vencimiento,
          tipo_operacion,
          proveedor: tercero.razon_social || 'TERCERO NO IDENTIFICADO',
          nit_tercero: tercero.nit || 'N/A',
          telefono: tercero.telefono,
          direccion: tercero.direccion,
          ciudad: tercero.ciudad,
          departamento: tercero.departamento,
          correo: tercero.correo,
          descripcion_item: descripcion,
          cantidad: cantidadTotal,
          valor_unitario: lineas.length === 1 ? lineas[0].valor_unitario : (cantidadTotal ? subtotalVal / cantidadTotal : subtotalVal),
          subtotal: signo * subtotalVal,
          iva: signo * ivaVal,
          total: signo * totalVal,
          casilla_350,
          retencion_porc,
          retencion_valor: signo * retencion_valor,
          reteica_tarifa: 0,
          reteiva_porc: 0,
          forma_pago,
          medio_pago,
          cuenta_gasto,
          tipo_comprobante: isCreditNote ? 'Nota de Crédito' : 'Factura Electrónica',
          cufe_hash,
          estado_revision: 'PENDIENTE',
          items: lineas,
          datos_ubl: {
            emisor,
            adquiriente,
            tipo_operacion_dian: TIPOS_OPERACION[etiqueta(sinPartes, 'CustomizationID')] || etiqueta(sinPartes, 'CustomizationID') || undefined,
            moneda: etiqueta(sinPartes, 'DocumentCurrencyCode') || 'COP',
            orden_pedido: etiqueta(bloque(sinPartes, 'OrderReference'), 'ID') || undefined,
            archivo_origen: fileName
          }
        }
      ];
    } catch (err: any) {
      console.error("[XML-Parser] Error parseando XML UBL:", err);
      return [];
    }
  }
}

export const xmlParser = new XmlUblParserService();
