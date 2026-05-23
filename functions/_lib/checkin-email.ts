/// <reference types="@cloudflare/workers-types" />
//
// Correo #2 — Recordatorio de check-in. Se envía la NOCHE ANTERIOR a la llegada
// (6 PM hora Honduras) con la info de acceso de la propiedad: wifi, código de
// puerta / cómo recoger llaves, instrucciones de llegada y contacto local.
//
// La info viene de `getCheckinInfo()` (Google Sheet privado → cache D1).
// El envío lo hace `sendViaResend()`.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { sendViaResend, type ResendEnv, type SendEmailResult } from "./resend";
import { uint8ToBase64 } from "./checkin-pdf";
import type { CheckinInfo } from "./checkin-info";

const WHATSAPP_NUMBER = "50488390145";
const SUPPORT_EMAIL = "hola@estadiasjacari.com";

export interface CheckinReminderData {
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  checkInISO: string; // YYYY-MM-DD
  checkOutISO: string; // YYYY-MM-DD
  info: CheckinInfo;
  /** PDF de bienvenida opcional (bytes leídos de R2 vía `getCheckinPdf`). */
  pdf?: {
    bytes: Uint8Array;
    filename: string;
  };
}

/**
 * Envía el correo de recordatorio de check-in al huésped vía Resend.
 * No lanza excepciones — devuelve SendEmailResult.
 */
export async function sendCheckinReminderEmail(
  data: CheckinReminderData,
  env: ResendEnv,
): Promise<SendEmailResult> {
  if (!data.guestEmail) {
    return { ok: false, error: "guestEmail vacío — no hay destinatario" };
  }

  const propertyName = data.info.propertyName || "tu propiedad";
  const subject = `🔑 Instrucciones para tu llegada — ${propertyName} (${formatDateEs(data.checkInISO)})`;
  const html = buildHtmlBody(data);
  const text = buildPlainTextBody(data);

  // Si llega `pdf`, lo adjuntamos en base64. Resend cobra el adjunto contra
  // el límite de 40 MB total del correo. Si no hay PDF, el correo igual sale
  // (graceful degradation — el cuerpo tiene toda la info).
  const attachments = data.pdf
    ? [
        {
          filename: data.pdf.filename,
          content: uint8ToBase64(data.pdf.bytes),
        },
      ]
    : undefined;

  return sendViaResend(
    { to: data.guestEmail, subject, html, text, attachments },
    env,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de formato (duplicados a propósito de email.ts para mantener este
// módulo independiente y sin acoplar el Correo #1 con el Correo #2)
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

/** WhatsApp con texto pre-llenado para que el huésped consulte su check-in. */
function buildWhatsAppLink(data: CheckinReminderData): string {
  const propertyName = data.info.propertyName || "mi reserva";
  const message =
    `Hola, soy ${data.guestName}. Mi check-in en ${propertyName} es el ` +
    `${formatDateEs(data.checkInISO)}. Tengo una consulta sobre mi llegada.`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Texto plano (fallback)
// ─────────────────────────────────────────────────────────────────────────────

function buildPlainTextBody(data: CheckinReminderData): string {
  const i = data.info;
  const lines: string[] = [];
  lines.push(`Hola ${data.guestName},`);
  lines.push("");
  lines.push(
    `¡Mañana es tu llegada a ${i.propertyName || "tu propiedad"}! Aquí tienes toda la información para tu check-in.`,
  );
  lines.push("");
  lines.push("DETALLES DE TU ESTADÍA");
  if (i.propertyName) lines.push(`- Propiedad: ${i.propertyName}`);
  lines.push(`- Check-in: ${formatDateEs(data.checkInISO)}`);
  lines.push(`- Check-out: ${formatDateEs(data.checkOutISO)}`);
  lines.push("");

  if (i.arrivalInstructions) {
    lines.push("CÓMO LLEGAR");
    lines.push(i.arrivalInstructions);
    lines.push("");
  }
  if (i.accessInstructions) {
    lines.push("CÓMO INGRESAR");
    lines.push(i.accessInstructions);
    lines.push("");
  }
  if (i.wifiNetwork || i.wifiPassword) {
    lines.push("WIFI");
    if (i.wifiNetwork) lines.push(`- Red: ${i.wifiNetwork}`);
    if (i.wifiPassword) lines.push(`- Contraseña: ${i.wifiPassword}`);
    lines.push("");
  }
  if (i.localContactName || i.localContactPhone) {
    lines.push("CONTACTO LOCAL");
    if (i.localContactName) lines.push(`- ${i.localContactName}`);
    if (i.localContactPhone) lines.push(`- ${i.localContactPhone}`);
    lines.push("");
  }
  if (i.extraNotes) {
    lines.push("NOTAS ADICIONALES");
    lines.push(i.extraNotes);
    lines.push("");
  }

  lines.push(
    `¿Alguna duda antes de llegar? Escríbenos por WhatsApp al +504 8839-0145:`,
  );
  lines.push(buildWhatsAppLink(data));
  lines.push("");
  lines.push("¡Te deseamos una excelente estadía!");
  lines.push("");
  lines.push("— Equipo Estadías Jacarí");
  lines.push(`${SUPPORT_EMAIL} · +504 8839-0145`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML (table-based, compatible con Gmail/Outlook/Apple Mail)
// ─────────────────────────────────────────────────────────────────────────────

/** Bloque de sección con título + contenido (multilínea → <br>). */
function section(title: string, body: string): string {
  const safe = escapeHtml(body).replace(/\n/g, "<br>");
  return `
          <tr>
            <td style="padding:22px 32px 0 32px;">
              <h3 style="margin:0 0 8px 0; font-size:16px; color:#003F51; font-family: 'DM Serif Display', Georgia, serif; font-weight:400;">${escapeHtml(title)}</h3>
              <p style="margin:0; font-size:14px; line-height:1.7; color:#374151;">${safe}</p>
            </td>
          </tr>`;
}

function buildHtmlBody(data: CheckinReminderData): string {
  const i = data.info;
  const name = escapeHtml(data.guestName || "huésped");
  const propertyName = escapeHtml(i.propertyName || "tu propiedad");
  const waLink = buildWhatsAppLink(data);

  // Secciones condicionales (solo se renderizan si hay dato).
  let sections = "";
  if (i.arrivalInstructions) sections += section("Cómo llegar", i.arrivalInstructions);
  if (i.accessInstructions) sections += section("Cómo ingresar", i.accessInstructions);

  // Wifi como tarjeta destacada.
  let wifiBlock = "";
  if (i.wifiNetwork || i.wifiPassword) {
    const net = i.wifiNetwork
      ? `<tr><td style="font-size:13px; color:#6B7280; padding:3px 0; width:110px;">Red</td><td style="font-size:14px; color:#1A1A1A; font-weight:600; padding:3px 0;">${escapeHtml(i.wifiNetwork)}</td></tr>`
      : "";
    const pass = i.wifiPassword
      ? `<tr><td style="font-size:13px; color:#6B7280; padding:3px 0;">Contraseña</td><td style="font-size:14px; color:#1A1A1A; font-weight:600; font-family: 'SF Mono', Monaco, Consolas, monospace; padding:3px 0;">${escapeHtml(i.wifiPassword)}</td></tr>`
      : "";
    wifiBlock = `
          <tr>
            <td style="padding:22px 32px 0 32px;">
              <h3 style="margin:0 0 8px 0; font-size:16px; color:#003F51; font-family: 'DM Serif Display', Georgia, serif; font-weight:400;">WiFi</h3>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8F7F4; border-radius:10px;">
                <tr><td style="padding:14px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${net}${pass}</table></td></tr>
              </table>
            </td>
          </tr>`;
  }

  let contactBlock = "";
  if (i.localContactName || i.localContactPhone) {
    const parts = [i.localContactName, i.localContactPhone]
      .filter(Boolean)
      .map((p) => escapeHtml(String(p)))
      .join(" · ");
    contactBlock = section("Contacto local", parts);
  }

  let notesBlock = "";
  if (i.extraNotes) notesBlock = section("Notas adicionales", i.extraNotes);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instrucciones de check-in</title>
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

          <!-- Intro -->
          <tr>
            <td style="padding:32px 32px 0 32px;">
              <div style="display:inline-block; background:#FEF3C7; color:#92400E; padding:6px 14px; border-radius:9999px; font-size:13px; font-weight:600;">
                🔑 Tu llegada es mañana
              </div>
              <h2 style="margin:18px 0 6px 0; font-size:22px; color:#003F51; font-family: 'DM Serif Display', Georgia, serif; font-weight:400;">¡Todo listo, ${name}!</h2>
              <p style="margin:0; font-size:15px; line-height:1.6; color:#374151;">
                Mañana es tu check-in en <strong>${propertyName}</strong> (${escapeHtml(formatDateEs(data.checkInISO))}). Aquí tienes toda la información para tu llegada.
              </p>
            </td>
          </tr>
${sections}${wifiBlock}${contactBlock}${notesBlock}

          <!-- CTA WhatsApp -->
          <tr>
            <td style="padding:26px 32px 0 32px;">
              <p style="margin:0 0 14px 0; font-size:14px; line-height:1.6; color:#374151;">
                ¿Alguna duda antes de llegar? Escríbenos por WhatsApp — el botón abre un chat directo:
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <a href="${waLink}" style="display:inline-block; background:#D2A436; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:10px; font-size:15px; font-weight:600;">
                      Escribir por WhatsApp →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:36px 32px 32px 32px;">
              <p style="margin:0 0 4px 0; font-size:14px; color:#374151;">¡Te deseamos una excelente estadía!</p>
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
