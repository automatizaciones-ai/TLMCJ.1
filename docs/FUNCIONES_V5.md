# Consola TLM v5: paridad con Consola TLM Cloud

Esta versión toma las funciones de https://consola-tlm-cloud.onrender.com/ y las suma a lo que ya traía la v4. Todo sigue separado por empresa.

## Siigo Nube (integración real)

- `src/server/services/siigoService.ts` se autentica contra `POST https://api.siigo.com/auth` con el usuario y la access key de cada empresa. Guarda el token en caché y lo renueva cuando Siigo responde 401.
- **Config. Siigo** (en Cargue & Auditoría) prueba las credenciales en vivo antes de guardarlas. Si la llave se deja vacía, se conserva la que ya estaba guardada.
- `GET /api/v1/empresas/:id/siigo/catalogos` trae de Siigo los medios de pago (`/v1/payment-types`) y los impuestos (`/v1/taxes`), clasificados en ReteFuente, ReteICA y ReteIVA. Si la empresa no tiene Siigo configurado o Siigo no responde, usa el catálogo contingente DIAN de `src/shared/catalogosDian.ts`.
- `POST /api/v1/empresas/:id/siigo/enviar` crea las facturas de compra en Siigo (`POST /v1/purchases`) con el medio de pago y las retenciones elegidas en cada fila:
  - Omite las ventas y las facturas ya sincronizadas.
  - Devuelve exitosas, fallidas y la novedad de cada factura.
  - Genera un informe Excel que se archiva en la carpeta EXPORTES_ERP de la empresa.
- El botón **Enviar a SIIGO** se ve verde cuando la empresa está configurada y gris "(Sin conexión)" cuando no.

## Cargue & Auditoría

- Zona de arrastrar y soltar para paquetes .ZIP o archivos XML. Al terminar muestra cuántas facturas son nuevas y cuántas duplicadas se omitieron (se detectan por CUFE dentro de la misma empresa).
- La tabla muestra Cant., V. Unitario, Subtotal, IVA, Medio de pago, Cuenta contable y RteFte, RteICA y RteIVA en selectores por fila. En las ventas no se muestran retenciones.
- Al elegir una ReteFuente se asigna sola la casilla del F350: 61 para honorarios, 62 para servicios y 64 para compras.
- Junto a la cuenta contable hay un botón para copiarla. Si hay filtros activos, la cuenta se copia a las facturas filtradas; si no, a todas las facturas del mismo NIT. En ambos casos esas facturas quedan auditadas.
- Cada fila tiene su propio botón de auditoría, y las filas auditadas se resaltan en verde. También se puede auditar o devolver a pendiente en lote.
- Barra de asignación en lote para Banco o medio de pago, RteFte, RteICA y RteIVA.
- Filtros por periodo (desde y hasta) y por tipo (todas, compras o ventas). Los mismos filtros se aplican al Dashboard y al Formulario 350.
- Paginación de 25, 50 o 100 filas, o todas.
- Menú **Exportar** con Auditoría Excel, Plantilla ERP (Siigo) y Soportes PDF (ZIP).
- Visor de PDF dentro de la aplicación. Los modales se cierran con ESC.
- Borrar las facturas seleccionadas y **Vaciar todo** (`DELETE /api/v1/facturas/limpiar-todo?id_empresa=`). Vaciar todo solo lo puede usar un Administrador.

## Empresas por usuario

- `GET /api/v1/empresas` solo devuelve a cada usuario las empresas de su `empresas_ids`; los administradores ven todas. El cliente envía el encabezado `x-tlm-user-id`.
- Selector de cliente con búsqueda, logo o iniciales y NIT. Pide confirmación antes de cambiar de cliente y recuerda el último cliente usado.
- **Crear cliente** pide razón social, NIT, logo y ERP de destino. Quien lo crea queda asignado al cliente. Si el NIT ya existe, el servidor responde 409.
- Cuando el usuario no tiene clientes se muestra un aviso con el botón "Crear Mi Primer Cliente".
- El estado de Siigo en la barra lateral refleja si la empresa activa tiene credenciales.

## Conciliación y Centro Fiscal

- Un filtro por texto y por fecha se aplica a las tres listas de la conciliación (conciliadas, faltan en libros y faltan en banco). Cuando no quedan pendientes aparece el aviso "✓ CONCILIACIÓN PERFECTA (100%)".
- Se agregaron los bancos Banco Caja Social y Global66.
- El F350 (`/api/v1/impuestos/f350?desde=&hasta=`) solo toma las compras del periodo, arma la etiqueta del periodo con las fechas e incluye ReteICA y ReteIVA en los totales.

## Variables de entorno nuevas

| Variable | Uso |
|---|---|
| `SIIGO_API_BASE` | Base de la API de Siigo. Por defecto `https://api.siigo.com`. |
| `SIIGO_PARTNER_ID` | Encabezado `Partner-Id` que exige Siigo. |

## PDF original de los paquetes DIAN

- Al cargar un .zip, el sistema guarda el PDF que trae cada paquete y lo enlaza a su factura por CUFE. También funciona con varios paquetes dentro de un mismo .zip y con un XML y su PDF subidos como archivos sueltos.
- Cada PDF se empareja con su factura así:
  1. Mismo nombre de archivo que el XML.
  2. Si no, el nombre del PDF contiene el número de factura o el inicio del CUFE.
  3. Si en el paquete quedan un solo XML y un solo PDF sin pareja, se emparejan entre sí.
- Los PDF se guardan en la tabla `factura_soportes` de PostgreSQL, que es persistente en Render, y en una caché local en `/storage/soportes`.
- **Ver soporte PDF** muestra el PDF original. El botón del ojo aparece relleno cuando la factura tiene original. Si el paquete no traía PDF, se muestra la representación generada desde el XML con la etiqueta "Representación generada desde el XML".
- **Exportar → Soportes PDF (ZIP)** incluye los PDF originales. Los que se generan desde el XML llevan el sufijo `_REPRESENTACION_XML`.
- Las facturas que se cargaron antes de este cambio no tienen PDF guardado. Para guardarlo, basta volver a cargar el mismo .zip: las facturas se reconocen como duplicadas y no se repiten, pero el PDF sí queda guardado.

## Conciliación bancaria: lectura multibanco y cruce inteligente

- **Auxiliar de Siigo.** Se corrige el error "No se encontró el encabezado del auxiliar". El "Movimiento auxiliar por cuenta contable" de Siigo declara mal el tamaño de la hoja (A1:A31), y por eso solo se leía la primera columna; ahora el rango se recalcula con las celdas reales.
  - El saldo inicial y el final se toman de la fila "Cuenta contable:" (columnas Saldo inicial y Saldo total cuenta).
  - Si el archivo trae varias hojas, se busca el auxiliar en todas.
  - Si se carga un reporte de conciliación en lugar del auxiliar, el mensaje lo dice.
- **Extractos PDF de varios bancos.** El lector reconoce:
  - Fechas `1/06`, `01/06/2026`, `2026/06/01`, `01-06`, `01 JUN`, `JUN 01` y día y mes en columnas separadas (`01 06`, como en Davivienda).
  - El valor antes de la descripción (Davivienda) o al final de la línea, y las columnas Cargo / Abono / Saldo (BBVA).
  - Las marcas `CR` / `DB` y `+` / `-`, y los extractos ordenados del más reciente al más antiguo.
  - Cuando el banco no imprime el signo, lo corrige con el saldo corrido.
  - El saldo anterior y el actual se toman de la cifra que sigue a cada etiqueta, aunque en la misma línea aparezca "Saldo promedio".
  - El banco se detecta por el encabezado del extracto, no por los movimientos (un "PAGO PSE Banco Davivienda" en un extracto de Bancolombia ya no lo confunde). Se agregaron Global66, Banco Agrario, Bancoomeva, Falabella, Pichincha, Serfinanza, GNB Sudameris, Lulo y Confiar.
- **Cruce inteligente** (activo por defecto; la tolerancia por defecto es $100, como en Consola TLM Cloud). El cruce se hace en este orden:
  1. Misma fecha y valor.
  2. Valor igual dentro de los días de holgura.
  3. Mismo valor exacto en otra fecha del periodo, por ejemplo un pago contabilizado semanas después.
  4. **Agrupada:** un comprobante contable igual a la suma de varios movimientos del banco. Es el caso de los cierres de Siigo que registran en un solo CC el total del 4×1000, de los intereses o de las comisiones con IVA.
  5. **Agrupada:** un movimiento del banco igual a varios comprobantes de fechas cercanas.
- Cada partida conciliada muestra el tipo de cruce y la fecha del banco. El reporte Excel incluye las columnas "Tipo de cruce", "Fecha banco" y la cantidad de movimientos de cada lado.
