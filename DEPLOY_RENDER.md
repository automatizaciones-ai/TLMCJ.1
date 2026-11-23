# Desplegar Consola TLM en Render

Esta guía usa el archivo `render.yaml` del repositorio. Render crea el servicio y te pide los valores secretos.

## Antes de empezar

1. **Base de datos en Neon.** En [console.neon.tech](https://console.neon.tech) crea un proyecto y copia la *connection string* (Dashboard → Connect). Debe terminar en `?sslmode=require`.
2. **Correo SMTP.** Ten a la mano usuario, clave y servidor de tu proveedor (Gmail, Microsoft 365, Resend, SendGrid, etc.).
3. **Contraseña del administrador.** Elige una de al menos 8 caracteres. Es la que usarás para entrar la primera vez.

> ⚠️ **No despliegues sin `DATABASE_URL`.** El disco de Render se borra en cada despliegue. Sin Neon, perderías todos los datos.

## Paso 1: crear el servicio

1. En Render, pulsa **New → Blueprint**.
2. Elige el repositorio `527carlos/TLMCJ.1` y la rama `claude/inspiring-euler-frnrtz` (o `main` cuando se haga el merge).
3. Render leerá `render.yaml` y te pedirá estos valores:

| Variable | Qué poner |
|---|---|
| `DATABASE_URL` | La connection string de Neon |
| `ADMIN_EMAIL` | Correo del administrador, por ejemplo `automatizaciones@tlm.net.co` |
| `ADMIN_PASSWORD` | La contraseña del administrador (mínimo 8 caracteres) |
| `SMTP_HOST` | Servidor SMTP, por ejemplo `smtp.gmail.com` |
| `SMTP_USER` | Usuario SMTP |
| `SMTP_PASS` | Clave SMTP (en Gmail, una contraseña de aplicación) |
| `SMTP_FROM` | Remitente, por ejemplo `Consola TLM <no-reply@tlm.net.co>` |
| `APP_URL` | URL pública HTTPS si Render no proporciona `RENDER_EXTERNAL_URL` o usas un dominio propio |
| `APROBADOR_REGISTRO_EMAIL` | Correos separados por coma que recibirán enlaces de aprobación; por defecto se usa `ADMIN_EMAIL` |

`SESSION_SECRET` la genera Render sola. No la cambies salvo que tengas motivo.

4. Pulsa **Apply**. El primer despliegue tarda unos minutos.

## Paso 2: comprobar que funciona

1. Abre la URL del servicio (por ejemplo `https://consola-tlm.onrender.com`).
2. Revisa `https://TU-URL/health`. Debe responder `"status":"online"`.
3. En **Logs** busca estas dos líneas:
   - `[Correo] OK: Conexión SMTP correcta...`
   - `Servidor unificado ejecutándose...`
4. Entra con `ADMIN_EMAIL` y `ADMIN_PASSWORD`.

## Paso 3: después del primer ingreso

- **Crea las empresas reales** y cambia el nombre de las de ejemplo.
- **Crea los usuarios** desde Accesos. Así llega su clave provisional por correo.
- **Cambia tu contraseña** desde tu perfil si quieres una distinta a la inicial.

## Errores comunes

| Lo que ves en Logs | Qué hacer |
|---|---|
| `Falta ADMIN_PASSWORD` | Define `ADMIN_PASSWORD` en Environment y vuelve a desplegar |
| `Falta SESSION_SECRET` | Define `SESSION_SECRET` (Render debería generarla sola) |
| `No se pudo conectar a SMTP` | Revisa `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` y `SMTP_PASS` |
| `Revisa DATABASE_URL en .env` | Revisa usuario, clave, host y `?sslmode=require` en la connection string |
| Login responde 429 | Hay demasiados intentos fallidos. Espera 15 minutos |
| Login responde 503 al recuperar clave | El correo no está configurado: revisa las variables `SMTP_*` |

## Notas importantes

- **Plan:** `starter` evita que el servicio se duerma. Con `free` la primera carga tras un rato de inactividad es lenta.
- **Cuentas de demostración:** en producción no se crean. Solo existe el administrador que definiste en `ADMIN_EMAIL`. Las facturas y movimientos de ejemplo tampoco se cargan; empresas y plan de cuentas sí, para que la interfaz funcione.
- **Si ya cargaste datos en la versión local:** la copia local no pasa a Render. Tendrás que volver a subir tus XML o cargarlos desde la app.
- **Siigo y Google Cloud** siguen sin conexión real. La app lo informa en pantalla.
- Los enlaces de verificación y aprobación tienen una página de confirmación; abrirlos no procesa la acción. Los de aprobación vencen en 72 horas.
