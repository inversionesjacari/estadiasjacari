/// <reference types="@cloudflare/workers-types" />
//
// Correo de disculpa cuando el sitio rechaza un pago porque las fechas fueron
// tomadas por otro huésped en simultáneo (race condition).
//
// El cobro se hace y se refunde automáticamente — el huésped recibe DOS
// correos: este (de Estadías Jacarí) explicando qué pasó + el de PayPal
// confirmando el refund. Para que el huésped no se confunda, este correo
// es la fuente de verdad y reenvía a WhatsApp para encontrar alternativa.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { sendViaResend, type ResendEnv, type SendEmailResult } from "./resend";

const WHATSAPP_NUMBER = "50488390145";
const SUPPORT_EMAIL = "hola@estadiasjacari.com";

export interface OverlapApologyData {
  guestName: string;
  guestEmail: string;
  propertyName: string;
  checkInISO: string;
  checkOutISO: string;
  amountUsd: number;
  refundId?: string;
  refundStatus?: string;
}

const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function formatDateEs(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} de ${MONTHS_ES[m - 1]} de ${y}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildWhatsAppLink(data: OverlapApologyData): string {
  const message =
    `Hola, soy ${data.guestName}. Mi reserva en ${data.propertyName} del ` +
    `${formatDateEs(data.checkInISO)} al ${formatDateEs(data.checkOutISO)} ` +
    `no se pudo confirmar porque las fechas estaban tomadas. ¿Tienen alguna alternativa?`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export async function sendOverlapApologyEmail(
  data: OverlapApologyData,
  env: ResendEnv,
): Promise<SendEmailResult> {
  if (!data.guestEmail) {
    return { ok: false, error: "guestEmail vacío" };
  }

  const subject = `Reserva no confirmada — refund automático en proceso (${data.propertyName})`;
  const html = buildHtml(data);
  const text = buildText(data);

  return sendViaResend({ to: data.guestEmail, subject, html, text }, env);
}

function buildText(data: OverlapApologyData): string {
  return `Hola ${data.guestName},

Lamentamos profundamente avisarte que tu reserva en ${data.propertyName} del
${formatDateEs(data.checkInISO)} al ${formatDateEs(data.checkOutISO)} NO se
pudo confirmar.

¿QUÉ PASÓ?
Otro huésped reservó las mismas fechas a través de una de nuestras plataformas
externas (Airbnb, Booking) o de nuestro propio sitio en el mismo momento que
tú. Nuestro sistema detectó el conflicto y rechazó tu pago.

¿QUÉ HICIMOS?
Refundeamos automáticamente los USD $${data.amountUsd.toFixed(2)} a tu cuenta de
PayPal. El reembolso debería reflejarse en tu método de pago original en
3-5 días hábiles (depende de tu banco).
${data.refundId ? `Referencia de refund PayPal: ${data.refundId}\n` : ""}
¿QUÉ PUEDES HACER AHORA?
Si querés buscar fechas alternativas para esa propiedad o conocer otras de
nuestras opciones disponibles, escríbenos por WhatsApp:
${buildWhatsAppLink(data)}

Disculpá las molestias. Esto es muy raro pero pasó, y queríamos avisarte
inmediatamente con transparencia.

— Equipo Estadías Jacarí
${SUPPORT_EMAIL} · +504 8839-0145
`;
}

function buildHtml(data: OverlapApologyData): string {
  const g = {
    name: escapeHtml(data.guestName || "huésped"),
    property: escapeHtml(data.propertyName),
    checkIn: escapeHtml(formatDateEs(data.checkInISO)),
    checkOut: escapeHtml(formatDateEs(data.checkOutISO)),
    amount: data.amountUsd.toFixed(2),
    refundId: escapeHtml(data.refundId ?? ""),
  };
  const waLink = buildWhatsAppLink(data);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reserva no confirmada</title>
</head>
<body style="margin:0; padding:0; background-color:#F8F7F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#1A1A1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F8F7F4;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 4px 24px -8px rgba(0,63,49,0.15);">

          <tr>
            <td style="background:#003F51; padding:24px 32px;">
              <img src="https://estadiasjacari.com/logo-white.svg" alt="Estadías Jacarí" height="36" style="display:block; height:36px; max-width:200px;">
              <p style="margin:8px 0 0 0; font-size:13px; color:rgba(255,255,255,0.7);">Alquileres temporales en Honduras</p>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 32px 0 32px;">
              <div style="display:inline-block; background:#FEE2E2; color:#991B1B; padding:6px 14px; border-radius:9999px; font-size:13px; font-weight:600;">
                ⚠️ Reserva no confirmada
              </div>
              <h2 style="margin:18px 0 6px 0; font-size:22px; color:#003F51; font-family: 'DM Serif Display', Georgia, serif; font-weight:400;">Disculpá, ${g.name}</h2>
              <p style="margin:0; font-size:15px; line-height:1.6; color:#374151;">
                Tu reserva en <strong>${g.property}</strong> del ${g.checkIn} al ${g.checkOut} no se pudo confirmar porque las fechas fueron tomadas por otro huésped en simultáneo.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 32px 0 32px;">
              <h3 style="margin:0 0 8px 0; font-size:16px; color:#003F51; font-family: 'DM Serif Display', Georgia, serif; font-weight:400;">Refund automático</h3>
              <p style="margin:0 0 8px 0; font-size:14px; line-height:1.7; color:#374151;">
                Refundeamos automáticamente los <strong>USD $${g.amount}</strong> a tu cuenta de PayPal. Debería reflejarse en tu método de pago original en <strong>3-5 días hábiles</strong>.
              </p>
              ${g.refundId ? `<p style="margin:0; font-size:12px; color:#6B7280;">Referencia PayPal: <span style="font-family: 'SF Mono', Monaco, Consolas, monospace;">${g.refundId}</span></p>` : ""}
            </td>
          </tr>

          <tr>
            <td style="padding:28px 32px 0 32px;">
              <p style="margin:0 0 14px 0; font-size:14px; line-height:1.6; color:#374151;">
                ¿Querés ver fechas alternativas o explorar nuestras otras propiedades? Escríbenos por WhatsApp y te ayudamos a encontrar algo que funcione:
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <a href="${waLink}" style="display:inline-block; background:#D2A436; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:10px; font-size:15px; font-weight:600;">
                      Buscar alternativas por WhatsApp →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:36px 32px 32px 32px;">
              <p style="margin:0 0 4px 0; font-size:14px; color:#374151;">Disculpá las molestias. Esto es muy raro pero queríamos avisarte de inmediato con transparencia.</p>
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
