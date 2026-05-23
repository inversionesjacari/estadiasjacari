/// <reference types="@cloudflare/workers-types" />
//
// Helper compartido para envío de emails transaccionales vía Resend API.
//
// Uso desde una Pages Function:
//   import { sendReservationConfirmationEmail } from "../_lib/email";
//   await sendReservationConfirmationEmail(data, env);
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint por
// Cloudflare Pages — solo se puede importar desde otros archivos de functions/.
//

import { sendViaResend } from "./resend";

const WHATSAPP_NUMBER = "50488390145";
const SUPPORT_EMAIL = "hola@estadiasjacari.com";

export interface ReservationEmailData {
  guestName: string;
  guestEmail: string;
  guestPhone: string; // formato libre o normalizado — se usa para wa.me link
  propertyName: string;
  checkInISO: string; // YYYY-MM-DD
  checkOutISO: string; // YYYY-MM-DD
  nights: number;
  amountUsd: number;
  paypalOrderId: string;
}

export interface EmailEnv {
  RESEND_API_KEY: string;
  EMAIL_FROM: string; // ej. 'Estadías Jacarí <hola@estadiasjacari.com>'
  EMAIL_REPLY_TO?: string;
}

export interface EmailResult {
  ok: boolean;
  resendId?: string;
  error?: string;
}

/**
 * Envía email de confirmación de reserva al cliente vía Resend.
 * Devuelve `{ ok: true, resendId }` en éxito; `{ ok: false, error }` en fallo.
 * NO lanza excepciones — siempre devuelve un EmailResult.
 */
export async function sendReservationConfirmationEmail(
  data: ReservationEmailData,
  env: EmailEnv,
): Promise<EmailResult> {
  if (!data.guestEmail) {
    return { ok: false, error: "guestEmail vacío — no hay destinatario" };
  }

  const subject = `✅ Reserva confirmada — ${data.propertyName} (${formatDateEs(data.checkInISO)} al ${formatDateEs(data.checkOutISO)})`;
  const html = buildHtmlBody(data);
  const text = buildPlainTextBody(data);

  // El envío (incl. validación de RESEND_API_KEY/EMAIL_FROM) lo centraliza
  // sendViaResend. SendEmailResult tiene la misma forma que EmailResult.
  return sendViaResend({ to: data.guestEmail, subject, html, text }, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de formato
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** "2026-05-26" → "26 de mayo de 2026" */
function formatDateEs(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} de ${MONTHS_ES[m - 1]} de ${y}`;
}

/** Escapa los 5 caracteres de HTML inyectables. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Construye el href de WhatsApp con texto pre-llenado.
 * El cliente clickea el botón en el email → se abre WhatsApp con el mensaje
 * listo para enviar al +504 8839-0145.
 */
function buildWhatsAppLink(data: ReservationEmailData): string {
  const message =
    `Hola, soy ${data.guestName}. Confirmo mi reserva en ` +
    `${data.propertyName} del ${formatDateEs(data.checkInISO)} al ` +
    `${formatDateEs(data.checkOutISO)}. ¡Gracias!`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas (HTML para clientes modernos, texto plano para fallback)
// ─────────────────────────────────────────────────────────────────────────────

function buildPlainTextBody(data: ReservationEmailData): string {
  return `Hola ${data.guestName},

¡Gracias por reservar con Estadías Jacarí! Tu pago fue procesado exitosamente.

DETALLES DE TU RESERVA
- Propiedad: ${data.propertyName}
- Check-in: ${formatDateEs(data.checkInISO)} (entrada: 3:00 PM)
- Check-out: ${formatDateEs(data.checkOutISO)} (salida: 11:00 AM)
- Noches: ${data.nights}
- Monto pagado: USD $${data.amountUsd.toFixed(2)}
- Número de orden PayPal: ${data.paypalOrderId}

¿QUÉ SIGUE?

La noche anterior a tu llegada te enviaremos por correo y WhatsApp un set
completo de instrucciones para que puedas ingresar fácilmente a la propiedad
(dirección exacta, código de la puerta o forma de recoger las llaves,
contacto del encargado local, etc.).

Si tienes cualquier pregunta antes de tu llegada, escríbenos al
WhatsApp +504 8839-0145 (puedes usar este link directo):
${buildWhatsAppLink(data)}

¡Te esperamos!

— Equipo Estadías Jacarí
${SUPPORT_EMAIL} · +504 8839-0145
`;
}

function buildHtmlBody(data: ReservationEmailData): string {
  const g = {
    name: escapeHtml(data.guestName || "huésped"),
    property: escapeHtml(data.propertyName),
    checkIn: escapeHtml(formatDateEs(data.checkInISO)),
    checkOut: escapeHtml(formatDateEs(data.checkOutISO)),
    nights: data.nights,
    amount: data.amountUsd.toFixed(2),
    orderId: escapeHtml(data.paypalOrderId),
  };
  const waLink = buildWhatsAppLink(data);

  // Estilos inline + table-based layout para máxima compatibilidad con
  // Gmail, Outlook, Apple Mail, Yahoo, etc.
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reserva confirmada</title>
</head>
<body style="margin:0; padding:0; background-color:#F8F7F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#1A1A1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F8F7F4;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 4px 24px -8px rgba(0,63,49,0.15);">

          <!-- Header con marca -->
          <tr>
            <td style="background:#003F51; padding:28px 32px;">
              <h1 style="margin:0; font-size:22px; font-weight:600; color:#ffffff; letter-spacing:-0.01em; font-family: 'DM Serif Display', Georgia, serif;">Estadías Jacarí</h1>
              <p style="margin:6px 0 0 0; font-size:13px; color:rgba(255,255,255,0.7);">Alquileres temporales en Honduras</p>
            </td>
          </tr>

          <!-- Status badge -->
          <tr>
            <td style="padding:32px 32px 0 32px;">
              <div style="display:inline-block; background:#ECFDF5; color:#047857; padding:6px 14px; border-radius:9999px; font-size:13px; font-weight:600;">
                ✅ Reserva confirmada
              </div>
              <h2 style="margin:18px 0 6px 0; font-size:22px; color:#003F51; font-family: 'DM Serif Display', Georgia, serif; font-weight:400;">¡Gracias, ${g.name}!</h2>
              <p style="margin:0; font-size:15px; line-height:1.6; color:#374151;">
                Tu pago fue procesado exitosamente. Aquí están los detalles de tu reserva.
              </p>
            </td>
          </tr>

          <!-- Card de detalles -->
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8F7F4; border-radius:10px; padding:20px;">
                <tr>
                  <td style="padding:16px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="font-size:13px; color:#6B7280; padding:4px 0; width:130px;">Propiedad</td>
                        <td style="font-size:14px; color:#003F51; font-weight:600; padding:4px 0;">${g.property}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px; color:#6B7280; padding:4px 0;">Check-in</td>
                        <td style="font-size:14px; color:#1A1A1A; padding:4px 0;">${g.checkIn} <span style="color:#6B7280; font-size:12px;">(3:00 PM)</span></td>
                      </tr>
                      <tr>
                        <td style="font-size:13px; color:#6B7280; padding:4px 0;">Check-out</td>
                        <td style="font-size:14px; color:#1A1A1A; padding:4px 0;">${g.checkOut} <span style="color:#6B7280; font-size:12px;">(11:00 AM)</span></td>
                      </tr>
                      <tr>
                        <td style="font-size:13px; color:#6B7280; padding:4px 0;">Noches</td>
                        <td style="font-size:14px; color:#1A1A1A; padding:4px 0;">${g.nights}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px; color:#6B7280; padding:4px 0;">Monto pagado</td>
                        <td style="font-size:14px; color:#1A1A1A; padding:4px 0;">USD $${g.amount}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px; color:#6B7280; padding:4px 0;">Orden PayPal</td>
                        <td style="font-size:12px; color:#6B7280; font-family: 'SF Mono', Monaco, Consolas, monospace; padding:4px 0;">${g.orderId}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ¿Qué sigue? -->
          <tr>
            <td style="padding:28px 32px 0 32px;">
              <h3 style="margin:0 0 10px 0; font-size:17px; color:#003F51; font-family: 'DM Serif Display', Georgia, serif; font-weight:400;">¿Qué sigue?</h3>
              <p style="margin:0; font-size:14px; line-height:1.7; color:#374151;">
                La <strong>noche anterior a tu llegada</strong> te enviaremos por correo y WhatsApp un set completo de instrucciones para que puedas ingresar fácilmente a la propiedad: dirección exacta, código de la puerta o forma de recoger las llaves, contacto del encargado local, y cualquier detalle importante de tu estadía.
              </p>
            </td>
          </tr>

          <!-- CTA WhatsApp -->
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <p style="margin:0 0 14px 0; font-size:14px; line-height:1.6; color:#374151;">
                Si tienes <strong>cualquier consulta antes de tu llegada</strong>, escríbenos por WhatsApp al +504 8839-0145. El botón de abajo abre un chat con tu mensaje pre-llenado:
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <a href="${waLink}" style="display:inline-block; background:#D2A436; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:10px; font-size:15px; font-weight:600;">
                      Confirmar llegada por WhatsApp →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:36px 32px 32px 32px;">
              <p style="margin:0 0 4px 0; font-size:14px; color:#374151;">¡Te esperamos!</p>
              <p style="margin:0; font-size:14px; color:#374151;">— Equipo <strong>Estadías Jacarí</strong></p>
              <hr style="border:none; border-top:1px solid #E5E7EB; margin:20px 0;">
              <p style="margin:0; font-size:12px; color:#9CA3AF; line-height:1.6;">
                <a href="mailto:${SUPPORT_EMAIL}" style="color:#289DAE; text-decoration:none;">${SUPPORT_EMAIL}</a>
                · WhatsApp <a href="https://wa.me/${WHATSAPP_NUMBER}" style="color:#289DAE; text-decoration:none;">+504 8839-0145</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
