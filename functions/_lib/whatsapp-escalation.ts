/// <reference types="@cloudflare/workers-types" />
//
// Notificación a César por email cuando el bot de WhatsApp no pudo responder
// (ninguna regla matcheó, o el huésped pidió hablar con humano).
//
// Por qué email y no WhatsApp:
//   1. El número personal de César (+504 9764-9035) no inició conversación
//      con la API en las últimas 24h → enviarle por WhatsApp obligaría a usar
//      un template aprobado dedicado (complejidad innecesaria para MVP).
//   2. El email ya está configurado: hola@estadiasjacari.com llega a su Gmail
//      vía Cloudflare Email Routing. Notificación push instantánea desde Gmail.
//   3. El link wa.me/<número> en el body permite responder en 2 clicks.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { sendViaResend, type ResendEnv, type SendEmailResult } from "./resend";
import { notifyOwners, type OwnerAlertEnv } from "./owner-alerts";
import { isCallRequested, isPaymentReported } from "./detectors";
import type { ActiveReservation } from "./whatsapp-bot";

const SUPPORT_EMAIL = "hola@estadiasjacari.com";
const CESAR_PERSONAL_WA = "50497649035";

/**
 * Prefijo de severidad para el ASUNTO del email (B8, 2026-07-11): mientras el
 * canal WhatsApp se diagnostica, el email es el aviso principal — que el filtro
 * de Gmail de César pueda distinguir "hay plata en juego" de "mirá cuando puedas".
 *   🔴 pago/comprobante (plata en la mano)  ·  🟠 escalado que espera un humano
 *   ⚪ resto (informativo). Función pura, testeada en owner-alerts.test.ts.
 */
export function severityPrefix(reason: string): string {
  const r = reason.toLowerCase();
  if (/pag[oó]|comprobante|transferencia|deposit/i.test(r)) return "🔴";
  if (/humano|escal|soporte|evento|largo plazo|llamada|sin responder|recuperarse/i.test(r)) return "🟠";
  return "⚪";
}

/**
 * ¿Esta escalación merece SONAR el teléfono de César por WhatsApp, o basta con
 * el email + el inbox? (César, 2026-07-12: "que solo me llame para lo
 * estrictamente necesario".) El email SIEMPRE sale — es el respaldo filtrable en
 * Gmail, con su prefijo 🔴/🟠/⚪. Esta función SOLO decide el ping de WhatsApp.
 *
 * PINGA (crítico, lo que César pidió que le llegue):
 *   🔴 plata en juego     — reportó un pago, mandó comprobante/transferencia a verificar.
 *   🟠 espera a un humano  — pidió hablar/llamada, huésped existente pide soporte,
 *                            lead de evento, renta a largo plazo, o el bot quedó caído.
 * NO PINGA (el ruido que pidió callar) → queda mudo en el email + inbox:
 *   ⚪ media suelta (foto, nota de voz, video, sticker, documento, contacto) y
 *      "el bot no matcheó ninguna regla".
 *
 * Red de seguridad: también mira el MENSAJE del huésped. Una nota de voz
 * transcrita como "quiero que me llamen" o una foto con caption "ya hice el
 * pago" SÍ pinga, aunque la razón del sistema sea genérica — así no se muta un
 * pedido de humano hablado ni un comprobante mandado por fuera del flujo de pago.
 */
export function shouldPingOwner(reason: string, guestMessage = ""): boolean {
  return severityPrefix(reason) !== "⚪" || guestSignalsCritical(guestMessage);
}

/**
 * Señales críticas en el TEXTO libre del huésped (nota de voz transcrita, caption
 * de una foto). Más amplio que severityPrefix a propósito: cubre las formas
 * habladas de Honduras ("me llaman", "hablar con alguien", "ya deposité"). Ante
 * la duda, pinga: perder un pedido de humano o un aviso de pago cuesta más que un
 * ping de más. Función pura (testeable).
 */
export function guestSignalsCritical(msg: string): boolean {
  if (!msg) return false;
  // FUENTE ÚNICA de intención de pago/llamada: los MISMOS detectores que usa el
  // bot (acento-insensibles y más completos que una regex a mano). Cubren
  // "podrian llamarme", "que me llamen", "ya pague", "adjunto comprobante", etc.
  // (Rev. adversaria 2026-07-12: reusar el detector cierra la regresión del
  // huésped con reserva que pedía llamada/pago con vocabulario que una regex
  // casera no cachaba.)
  if (isCallRequested(msg) || isPaymentReported(msg)) return true;

  // Suplemento SOLO para lo que los detectores NO cubren y en Honduras sí aparece.
  const t = msg.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Pago: verbos sueltos + formas hondureñas (cancelar/abonar = pagar) + comprobante.
  // El infinitivo "cancelar"/"abonar" queda fuera a propósito ("cancelar" = anular
  // reserva). "recibo" se ancla a "recibo de pago" para no chocar con el verbo
  // recibir ("¿a qué hora recibo las llaves?").
  const paymentExtra =
    /\bpag(o|ue|ar|ados?|amos)\b|\bdeposit(e|o|ar|ados?)\b|\btransfer(i|encia|ir)\b|\bcomprobante\b|\bvoucher\b|\brecibo de pago\b|\bcancel(e|ado)\b|\bcancele el\b|\babon(e|o|ar|ados?)\b/.test(t);
  // Pedido de HUMANO (no de llamada — eso ya lo cubre isCallRequested): persona
  // real / asesor / agente / urgencia.
  const humanExtra =
    /\bhablar con (alguien|una persona|un humano|un asesor|un agente|el equipo)\b|\buna persona real\b|\bun (humano|asesor|agente)\b|\burgente\b|\bemergencia\b/.test(t);
  return paymentExtra || humanExtra;
}

const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
};

export interface EscalationData {
  /** Texto original del huésped. */
  guestMessage: string;
  /** Teléfono del huésped (E.164 sin '+'). */
  guestPhone: string;
  /** Reserva activa si la encontramos. */
  reservation: ActiveReservation | null;
  /** Razón de la escalación (no matcheó regla, pidió humano, etc.). */
  reason: string;
  /**
   * Fuerza el ping de WhatsApp aunque la clasificación por texto no lo marque
   * crítico. Lo setean los call sites que YA SABEN que es crítico y no pueden
   * confiar en el texto de la razón: un handoff a humano iniciado por una regla
   * (el bot le prometió un humano al huésped), un comprobante mandado como foto
   * suelta, o una nota de voz que no se pudo transcribir. Es la señal confiable;
   * shouldPingOwner (texto) es solo la red de respaldo. (Revisión adversaria
   * 2026-07-12: sin esto se mutaban pagos y handoffs reales.)
   */
  forcePing?: boolean;
}

/**
 * Envía un email a hola@estadiasjacari.com con el contexto del mensaje sin
 * responder por el bot. Incluye un link `wa.me/50497649035` para que César
 * abra WhatsApp con un toque.
 */
export async function sendEscalationEmail(
  data: EscalationData,
  env: ResendEnv & OwnerAlertEnv,
): Promise<SendEmailResult> {
  const propertyName = data.reservation
    ? PROPERTY_NAMES[data.reservation.property_slug] || data.reservation.property_slug
    : "(sin reserva activa)";
  const guestName = data.reservation?.guest_name || "(desconocido)";

  // Para responder al huésped — abre WhatsApp Business directo al chat
  const replyToGuestUrl = `https://wa.me/${data.guestPhone}`;
  // Para que César abra su WhatsApp personal (referencia, normalmente no se usa)
  const cesarUrl = `https://wa.me/${CESAR_PERSONAL_WA}`;

  const subject = `${severityPrefix(data.reason)} WhatsApp: ${guestName} · ${propertyName}`;
  const text = buildText(data, propertyName, guestName, replyToGuestUrl);
  const html = buildHtml(data, propertyName, guestName, replyToGuestUrl, cesarUrl);

  // El email SIEMPRE sale (respaldo filtrable en Gmail, con prefijo de severidad).
  // El ping de WhatsApp (que le SUENA el teléfono a César) solo sale para lo
  // estrictamente necesario — pago/comprobante o algo que espera a un humano.
  // Todo lo demás (foto/nota de voz/sticker suelto, "no matcheó regla") queda
  // mudo aquí, pero visible en el email + inbox. (César, 2026-07-12.)
  // EN PARALELO, para no sumar latencia serial a la respuesta del webhook.
  // Fail-soft: si la plantilla aún no está aprobada en Meta, no rompe nada.
  const ping = data.forcePing === true || shouldPingOwner(data.reason, data.guestMessage);
  const [emailResult] = await Promise.all([
    sendViaResend({ to: SUPPORT_EMAIL, subject, html, text }, env),
    ping
      ? notifyOwners(env, {
          tipo: data.reason || "Necesita tu atención",
          cliente: `${guestName} (+${data.guestPhone})`,
          detalle: data.guestMessage,
          guestPhone: data.guestPhone,
        })
      : Promise.resolve(),
  ]);

  // Cámara best-effort: deja rastro de las alertas MUDAS para poder verificar en
  // bot_trace que el filtro trabaja y QUÉ se está callando (patrón de instrumentación
  // de B8). Nunca rompe el flujo.
  if (!ping && env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'OWNER_PING_SKIPPED', ?)`,
      )
        .bind(data.guestPhone || "", `${data.reason}`.slice(0, 200))
        .run();
    } catch {
      /* best-effort */
    }
  }

  return emailResult;
}

function buildText(
  data: EscalationData,
  propertyName: string,
  guestName: string,
  replyUrl: string,
): string {
  const lines: string[] = [];
  lines.push("🤖 BOT WHATSAPP — Mensaje sin respuesta");
  lines.push("");
  lines.push(`Huésped: ${guestName}`);
  lines.push(`Teléfono: +${data.guestPhone}`);
  lines.push(`Propiedad: ${propertyName}`);
  if (data.reservation) {
    lines.push(`Check-in: ${data.reservation.check_in}`);
    lines.push(`Check-out: ${data.reservation.check_out}`);
  }
  lines.push("");
  lines.push(`Razón: ${data.reason}`);
  lines.push("");
  lines.push("MENSAJE ORIGINAL:");
  lines.push(`> ${data.guestMessage}`);
  lines.push("");
  lines.push(`Responder por WhatsApp: ${replyUrl}`);
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtml(
  data: EscalationData,
  propertyName: string,
  guestName: string,
  replyUrl: string,
  _cesarUrl: string,
): string {
  const guestMsgSafe = escapeHtml(data.guestMessage).replace(/\n/g, "<br>");
  const reservationBlock = data.reservation
    ? `<tr><td style="color:#6B7280; padding:4px 0; width:90px;">Check-in</td><td style="padding:4px 0; font-weight:600;">${escapeHtml(data.reservation.check_in)}</td></tr>
       <tr><td style="color:#6B7280; padding:4px 0;">Check-out</td><td style="padding:4px 0; font-weight:600;">${escapeHtml(data.reservation.check_out)}</td></tr>`
    : `<tr><td colspan="2" style="color:#DC2626; padding:4px 0; font-style:italic;">Sin reserva activa registrada</td></tr>`;

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(propertyName)}</title></head>
<body style="margin:0; padding:0; background:#F8F7F4; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#1A1A1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8F7F4;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 4px 20px -8px rgba(0,63,49,.12);">
        <tr><td style="background:#003F51; padding:20px 28px;">
          <div style="font-size:13px; color:rgba(255,255,255,.7); margin-bottom:4px;">🤖 Bot WhatsApp</div>
          <div style="font-size:20px; color:#fff; font-weight:600;">Mensaje sin respuesta automática</div>
        </td></tr>

        <tr><td style="padding:24px 28px 0;">
          <div style="display:inline-block; background:#FEF3C7; color:#92400E; padding:5px 12px; border-radius:9999px; font-size:12px; font-weight:600;">${escapeHtml(data.reason)}</div>
        </td></tr>

        <tr><td style="padding:18px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8F7F4; border-radius:8px;">
            <tr><td style="padding:14px 16px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
                <tr><td style="color:#6B7280; padding:4px 0; width:90px;">Huésped</td><td style="padding:4px 0; font-weight:600;">${escapeHtml(guestName)}</td></tr>
                <tr><td style="color:#6B7280; padding:4px 0;">Teléfono</td><td style="padding:4px 0; font-weight:600;">+${escapeHtml(data.guestPhone)}</td></tr>
                <tr><td style="color:#6B7280; padding:4px 0;">Propiedad</td><td style="padding:4px 0; font-weight:600;">${escapeHtml(propertyName)}</td></tr>
                ${reservationBlock}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:22px 28px 0;">
          <h3 style="margin:0 0 8px; font-size:14px; color:#003F51;">Mensaje del huésped</h3>
          <div style="background:#fff; border-left:4px solid #289DAE; padding:12px 16px; font-size:14px; line-height:1.6; color:#374151;">
            ${guestMsgSafe}
          </div>
        </td></tr>

        <tr><td style="padding:24px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center">
              <a href="${replyUrl}" style="display:inline-block; background:#25D366; color:#fff; text-decoration:none; padding:14px 28px; border-radius:10px; font-size:15px; font-weight:600;">
                💬 Responder por WhatsApp
              </a>
            </td></tr>
          </table>
          <p style="margin:14px 0 0; font-size:11px; color:#9CA3AF; text-align:center;">
            Abre WhatsApp con el chat del huésped directo. Responder desde ahí.
          </p>
        </td></tr>

        <tr><td style="background:#F8F7F4; padding:14px 28px; border-top:1px solid #E5E7EB;">
          <p style="margin:0; font-size:11px; color:#9CA3AF; text-align:center;">
            <strong>Estadías Jacarí — Bot WhatsApp</strong> · escalación automática
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
