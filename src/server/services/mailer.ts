import nodemailer from 'nodemailer';

// Configuración SMTP por variables de entorno (Gmail, Resend, SendGrid, Microsoft 365, etc.)
//   SMTP_HOST, SMTP_PORT (587 por defecto), SMTP_USER, SMTP_PASS, SMTP_FROM
const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 587);

const transporter = host
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    })
  : null;

const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@tlm.net.co';

export const mailer = {
  enabled: transporter !== null,

  async send(to: string, subject: string, text: string, html?: string) {
    if (!transporter) {
      throw new Error('El servicio de correo no está configurado (define SMTP_HOST en .env).');
    }
    await transporter.sendMail({ from, to, subject, text, html });
  },

  // Comprueba la conexión y las credenciales con el servidor SMTP, sin enviar ningún correo.
  async verify(): Promise<{ ok: boolean; message: string }> {
    if (!transporter) {
      return { ok: false, message: 'SMTP_HOST no está definido: el correo está desactivado.' };
    }
    try {
      await transporter.verify();
      return { ok: true, message: `Conexión SMTP correcta con ${host}:${port}.` };
    } catch (e: any) {
      return { ok: false, message: `No se pudo conectar a SMTP (${host}:${port}): ${e.message}` };
    }
  }
};
