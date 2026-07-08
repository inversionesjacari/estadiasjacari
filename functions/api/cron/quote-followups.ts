/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/quote-followups
//
// Seguimiento automático: si un cliente dejó una cotización a medias y no
// respondió en ~10 minutos, el bot le reescribe UNA vez ("¿seguimos?") con un
// mensaje contextual según en qué paso quedó. Recupera ventas que se enfrían.
//
// Disparado por el Worker `estadia-jacari-cron` cada ~10 min.
// Auth: Authorization: Bearer <CRON_SECRET>
//
// Reglas:
//   - Solo estados activos sin cerrar (awaiting_quote_data, quote_provided,
//     awaiting_payment_method).
//   - Inactivo entre 10 min y 24 h (la ventana de 24h de WhatsApp para texto libre).
//   - Hasta 2 intentos de followup por conversación (followup_attempts < 2):
//       · Si Meta confirma el envío → se marca followup_sent_at y ya no se reintenta.
//       · Si Meta devuelve failed → solo se incrementa followup_attempts y el
//         siguiente tick lo reintenta, hasta agotar los 2 intentos.
//
// Respuesta SIEMPRE 200 con detalle JSON.
//

import { requireBearerAuth } from "../../_lib/admin-auth";
import { sendTextMessage } from "../../_lib/whatsapp";
import { PROPERTY_PRICING } from "../../_lib/quote-builder";
import { checkRangeAvailable, checkGemelasAvailable, type AvailabilityEnv } from "../../_lib/availability";
import { isNotInterested } from "../../_lib/quote-flow";
import { todayHn } from "../../_lib/dates";
import { T } from "../../_lib/i18n";
import { withCronMonitor } from "../../_lib/cron-monitor";
import { TERMINAL_RULES } from "../../_lib/detectors";

interface Env extends AvailabilityEnv {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

interface StateRow {
  phone: string;
  state: string;
  data: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Construye el mensaje de seguimiento según el paso en que quedó la charla. */
function buildFollowupMessage(state: string, data: Record<string, unknown>): string {
  const slug = typeof data.property === "string" ? data.property : null;
  const propName = slug && PROPERTY_PRICING[slug as keyof typeof PROPERTY_PRICING]
    ? PROPERTY_PRICING[slug as keyof typeof PROPERTY_PRICING].name
    : null;
  const city = typeof data.city === "string" ? data.city : null;
  const en = data.language === "en";
  const ref = propName
    ? en ? ` for ${propName}` : ` con ${propName}`
    : city
      ? en ? ` in ${city}` : ` en ${city}`
      : "";

  if (en) {
    switch (state) {
      case "quote_provided":
        return `Hi again! 👋 Did you get a chance to see the quote${ref}? If you'd like to book or have any questions, I'm here. 🙏`;
      case "awaiting_payment_method":
        return `Hi! Shall we continue with your booking${ref}? Let me know if you prefer *bank transfer* or *card/PayPal* and I'll send the details. 🙏`;
      case "awaiting_transfer_proof":
        return `Hi! 👋 Were you able to make the transfer${ref}? When you do, *send me a photo of the receipt here* and we'll confirm your booking. 🙏`;
      case "awaiting_paypal_capture":
        return `Hi! 👋 Were you able to complete the payment with the link${ref}? Let me know if you ran into any trouble. 🙏`;
      case "awaiting_quote_data":
      default:
        return buildGatherFollowup(data, ref, true);
    }
  }

  switch (state) {
    case "quote_provided":
      return `¡Hola de nuevo! 👋 ¿Pudiste ver la cotización${ref}? Si querés reservar o tenés alguna duda, estoy a la orden. 🙏`;
    case "awaiting_payment_method":
      return `¡Hola! ¿Seguimos con tu reserva${ref}? Decime si preferís *transferencia bancaria* o *tarjeta/PayPal* y te paso los datos enseguida. 🙏`;
    case "awaiting_transfer_proof":
      return `¡Hola! 👋 ¿Pudiste hacer la transferencia${ref}? Cuando la hagas, *mandame foto del comprobante por acá* y te confirmamos la reserva. 🙏`;
    case "awaiting_paypal_capture":
      return `¡Hola! 👋 ¿Pudiste completar el pago con el link${ref}? Si tuviste algún problema, avisame. 🙏`;
    case "awaiting_quote_data":
    default:
      return buildGatherFollowup(data, ref, false);
  }
}

/**
 * Followup cuando la charla quedó juntando datos (awaiting_quote_data).
 * Reconoce lo que el cliente YA dio (destino, personas, fechas) y pide SOLO lo
 * que falta. Repreguntar en genérico ("contame las fechas") cuando el cliente
 * ya las dio se siente como que el bot no lo escuchó, y enfría la venta.
 * `ref` ya trae el destino (" con X" / " en Ciudad") si lo hay.
 */
function buildGatherFollowup(data: Record<string, unknown>, ref: string, en: boolean): string {
  const hasProperty = typeof data.property === "string" && !!data.property;
  const hasDest = ref !== "";
  const hasGuests = typeof data.guests === "number" && (data.guests as number) > 0;
  const hasDates = Boolean(data.checkIn && data.checkOut);

  const missing: string[] = [];
  if (!hasDest) missing.push(en ? "the destination (La Ceiba, Tela or Tegucigalpa)" : "el destino (La Ceiba, Tela o Tegucigalpa)");
  if (!hasGuests) missing.push(en ? "how many guests" : "cuántas personas");
  if (!hasDates) missing.push(en ? "the dates" : "las fechas");

  // Tiene TODO (destino + personas + fechas) y AUN ASÍ seguimos en
  // awaiting_quote_data → no se pudo cerrar una cotización DISPONIBLE (si la
  // propiedad hubiera estado libre, el estado sería quote_provided). Causa
  // típica: esas fechas/propiedad sin disponibilidad o sobre capacidad. NO
  // insistir con "¿te muestro opciones con X?" (ya le dijimos que no había) ni
  // "¿viste la cotización?" — reconocerlo y ofrecer ALTERNATIVAS (rescata la
  // venta, honesto). Caso real: Melisa Urbina, Centro Morazán, 10-jun.
  if (missing.length === 0) {
    // "No me quedó disponible" SOLO si se intentó cotizar una PROPIEDAD específica
    // (property + fechas) y no había. Con solo la CIUDAD (sin elegir la casa — ej.
    // Tela tiene 2: Brisa y Marea), NO se cotizó nada → decir "no disponible" sería
    // falso y contradictorio con lo que el bot venía diciendo. Invitar a elegir.
    // (Bug real: Sandy Zelaya, Tela, 10-jun — "dos opciones disponibles" y el
    // followup dijo "no me quedó disponible".)
    if (hasProperty) {
      return en
        ? `Hi again! 👋 I couldn't find an opening${ref} for what you were looking for 😕 Want me to check other dates or show you another option? Happy to help. 🙏`
        : `¡Hola de nuevo! 👋 No me quedó disponible${ref} para lo que buscabas 😕 ¿Querés que busque otras fechas o te muestre otra opción? Con gusto te ayudo. 🙏`;
    }
    return en
      ? `Hi again! 👋 Shall we continue${ref}? Just tell me which option you like and I'll send you the quote. 🌴`
      : `¡Hola de nuevo! 👋 ¿Seguimos${ref}? Decime cuál opción te gusta y te paso la cotización enseguida. 🌴`;
  }

  const join = (xs: string[]) =>
    xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} ${en ? "and" : "y"} ${xs[xs.length - 1]}`;

  // Tono exploratorio, no transaccional: "te muestro opciones", no "la cotización".
  return en
    ? `Hi again! 👋 Shall we continue${ref}? Tell me ${join(missing)} and I'll show you some options. No rush! 🌴`
    : `¡Hola de nuevo! 👋 ¿Seguimos${ref}? Contame ${join(missing)} y te muestro opciones. ¡Sin apuro! 🌴`;
}

/**
 * Última regla REAL del bot para este número (ignora los propios followups).
 * Exportada: la reutiliza `cron/watchdog.ts` para no confundir un silencio
 * INTENCIONAL (conversación ya cerrada — TERMINAL_RULES) con un bot mudo real.
 */
export async function lastRealOutRule(phone: string, db: D1Database): Promise<string> {
  try {
    const r = await db.prepare(
      `SELECT matched_rule FROM whatsapp_messages
         WHERE to_phone = ? AND direction = 'out' AND matched_rule IS NOT NULL
           AND matched_rule NOT IN ('auto_followup','last_call','last_call_redirect')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(phone).first<{ matched_rule: string | null }>();
    return r?.matched_rule ?? "";
  } catch {
    return "";
  }
}

export const onRequestPost: PagesFunction<Env> = (context) =>
  withCronMonitor(context.env, "cron_followups", () => handlePost(context));

const handlePost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return json({ ok: false, error: "Faltan credenciales de WhatsApp" }, 500);
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  let rows: StateRow[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT phone, state, data
         FROM conversation_state
        WHERE state IN ('awaiting_quote_data', 'quote_provided', 'awaiting_payment_method', 'awaiting_transfer_proof', 'awaiting_paypal_capture')
          AND followup_sent_at IS NULL
          AND followup_attempts < 2
          AND updated_at <= datetime('now', '-10 minutes')
          AND updated_at >= datetime('now', '-24 hours')
          AND expires_at > datetime('now')
          AND phone NOT IN (SELECT phone FROM bot_pauses)
        LIMIT 20`,
    ).all<StateRow>();
    rows = res.results ?? [];
  } catch (err) {
    return json({ ok: false, error: `Error D1: ${(err as Error).message}` }, 500);
  }

  const results: Array<{ phone: string; state: string; sent: boolean; error?: string }> = [];

  for (const row of rows) {
    let data: Record<string, unknown> = {};
    if (row.data) {
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        /* data corrupto — seguir con {} */
      }
    }

    // No insistir con "armemos una cotización" a quien el bot ya cerró/derivó/cobró.
    // Este cron selecciona por estado del embudo, pero tras pagar (transfer_confirmed_*,
    // estado limpiado) un mensaje suelto del cliente RE-ABRE un awaiting_quote_data vacío
    // que el cron tomaba → "contame personas y fechas" a alguien que YA reservó, y lo hace
    // dudar de su reserva (caso Sandra, 12-jun). Guard simétrico al del último aviso:
    // saltamos si la última regla real fue terminal O si ya tiene una reserva activa/futura.
    const lastOutRule = await lastRealOutRule(row.phone, env.DB);
    let hasActiveReservation = false;
    try {
      const rv = await env.DB.prepare(
        `SELECT 1 FROM reservations
           WHERE (guest_phone_normalized = ? OR guest_phone = ?)
             AND status IN ('pending','confirmed')
             AND check_out >= date('now','-1 day')
           LIMIT 1`,
      ).bind(row.phone, row.phone).first();
      hasActiveReservation = !!rv;
    } catch { /* best-effort: ante error NO bloqueamos el followup */ }
    if ((lastOutRule && TERMINAL_RULES.has(lastOutRule)) || hasActiveReservation) {
      // Retirarlo del ciclo de followup (no re-evaluarlo cada tick).
      if (!dryRun) {
        try {
          await env.DB.prepare(
            `UPDATE conversation_state SET followup_sent_at = datetime('now') WHERE phone = ?`,
          ).bind(row.phone).run();
        } catch { /* best-effort */ }
      }
      const skipReason = lastOutRule && TERMINAL_RULES.has(lastOutRule) ? `skip_${lastOutRule}` : "skip_active_reservation";
      results.push({
        phone: row.phone,
        state: row.state,
        sent: false,
        error: dryRun ? `${skipReason} (dry)` : skipReason,
      });
      continue;
    }

    const message = buildFollowupMessage(row.state, data);

    if (dryRun) {
      results.push({ phone: row.phone, state: row.state, sent: false, error: "dryRun" });
      continue;
    }

    const sendResult = await sendTextMessage(row.phone, message, env);

    // Contabilizar el intento. NO tocamos updated_at: así el ciclo de
    // inactividad no se reinicia.
    //   - Envío OK   → marcar followup_sent_at + sumar intento: no se reintenta más.
    //   - Envío FAIL → solo sumar intento: el siguiente tick lo reintenta hasta
    //     llegar a 2 intentos (la query filtra followup_attempts < 2).
    try {
      await env.DB.prepare(
        sendResult.ok
          ? `UPDATE conversation_state
                SET followup_sent_at = datetime('now'),
                    followup_attempts = followup_attempts + 1
              WHERE phone = ?`
          : `UPDATE conversation_state
                SET followup_attempts = followup_attempts + 1
              WHERE phone = ?`,
      )
        .bind(row.phone)
        .run();
    } catch {
      /* best-effort */
    }

    // Registrar el mensaje saliente en el historial (para que aparezca en el inbox)
    if (sendResult.ok) {
      try {
        await env.DB.prepare(
          `INSERT INTO whatsapp_messages
             (meta_message_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
           VALUES (?, 'out', ?, ?, ?, 'auto_followup', 0, 'sent')`,
        )
          .bind(
            sendResult.messageId ?? null,
            env.WHATSAPP_PHONE_NUMBER_ID,
            row.phone,
            message,
          )
          .run();
      } catch {
        /* best-effort */
      }
    }

    results.push({
      phone: row.phone,
      state: row.state,
      sent: sendResult.ok,
      error: sendResult.ok ? undefined : sendResult.error,
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // ÚLTIMO AVISO — antes de que se cierre la ventana de 24h de WhatsApp.
  // Para no dejar morir leads activos que no respondieron. Antes de insistir:
  //   (1) NO molestar a quien ya cerró o no le interesó (isNotInterested).
  //   (2) Si tiene cotización, verificar que la fecha NO pasó y SIGA disponible
  //       — si ya no, ofrecer otras fechas/opciones en vez de insistir con esa.
  // Dispara ~20–24 h tras el último intercambio (margen antes del cierre de 24h).
  // Un solo toque por conversación (last_call_sent_at).
  // ════════════════════════════════════════════════════════════════════════
  const lastCall: Array<{ phone: string; sent: boolean; kind?: string; error?: string }> = [];
  try {
    const lc = await env.DB.prepare(
      `SELECT phone, state, data
         FROM conversation_state
        WHERE state IN ('awaiting_quote_data','quote_provided','awaiting_payment_method','awaiting_transfer_proof','awaiting_paypal_capture')
          AND last_call_sent_at IS NULL
          AND updated_at <= datetime('now','-20 hours')
          AND updated_at >= datetime('now','-24 hours')
          AND expires_at > datetime('now')
          AND phone NOT IN (SELECT phone FROM bot_pauses)
        LIMIT 20`,
    ).all<StateRow>();

    const today = todayHn();

    for (const row of lc.results ?? []) {
      let data: Record<string, unknown> = {};
      if (row.data) { try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { /* {} */ } }
      const lang = data.language === "en" ? "en" : "es";

      // Marcar como procesado SIEMPRE (mandemos o no) para no re-evaluarlo cada tick.
      const markDone = async () => {
        try { await env.DB.prepare(`UPDATE conversation_state SET last_call_sent_at = datetime('now') WHERE phone = ?`).bind(row.phone).run(); } catch { /* best-effort */ }
      };

      // (1) ¿El cliente ya mostró desinterés en su ÚLTIMO mensaje? → no molestar.
      let lastIn = "";
      try {
        const r = await env.DB.prepare(
          `SELECT body FROM whatsapp_messages WHERE from_phone = ? AND direction = 'in' ORDER BY created_at DESC, id DESC LIMIT 1`,
        ).bind(row.phone).first<{ body: string | null }>();
        lastIn = r?.body ?? "";
      } catch { /* best-effort */ }

      if (lastIn && isNotInterested(lastIn)) {
        await markDone();
        lastCall.push({ phone: row.phone, sent: false, kind: "skip_not_interested" });
        continue;
      }

      // (1.5) ¿La conversación terminó FUERA DE ALCANCE o escalada? → no insistir.
      // El último aviso es para cotizaciones tibias, no para leads que el bot ya
      // derivó (preguntó por algo que no ofrecemos, pidió humano, reportó pago…).
      // Buscamos la última regla "real" del bot, ignorando los propios followups.
      const lastOutRule = await lastRealOutRule(row.phone, env.DB);
      if (lastOutRule && TERMINAL_RULES.has(lastOutRule)) {
        await markDone();
        lastCall.push({ phone: row.phone, sent: false, kind: `skip_${lastOutRule}` });
        continue;
      }

      // (2) Verificar disponibilidad si hay cotización con fechas.
      const slug = typeof data.property === "string" ? data.property : null;
      const checkIn = typeof data.checkIn === "string" ? data.checkIn : null;
      const checkOut = typeof data.checkOut === "string" ? data.checkOut : null;
      const propName = slug && PROPERTY_PRICING[slug as keyof typeof PROPERTY_PRICING]
        ? PROPERTY_PRICING[slug as keyof typeof PROPERTY_PRICING].name : null;
      const city = typeof data.city === "string" ? data.city : null;
      const ref = propName
        ? (lang === "en" ? ` for ${propName}` : ` con ${propName}`)
        : city ? (lang === "en" ? ` in ${city}` : ` en ${city}`) : "";

      let stillOk = true; // sin fechas que verificar → tratamos como vivo
      if (slug && checkIn && checkOut) {
        if (checkIn < today) {
          stillOk = false; // la fecha ya pasó → no insistir con ella
        } else {
          const avail = slug === "las-gemelas-tela"
            ? await checkGemelasAvailable(checkIn, checkOut, env)
            : await checkRangeAvailable(slug, checkIn, checkOut, env);
          // Solo "no disponible" si lo CONFIRMAMOS; si no pudimos verificar (iCal
          // caído), asumimos vivo (no perder un lead por un fallo nuestro).
          if (avail.verified && !avail.available) stillOk = false;
        }
      }

      // 🌴 solo para zona de playa (Tela / La Ceiba); Tegucigalpa es ciudad → sin palmera.
      const beachSlugs = new Set(["casa-brisa", "casa-marea", "las-gemelas-tela", "villa-b11-palma-real"]);
      const beach = city === "Tela" || city === "La Ceiba" || (slug ? beachSlugs.has(slug) : false);
      const message = stillOk ? T.lastCallAlive(lang, ref, beach) : T.lastCallUnavailable(lang, ref, beach);
      if (dryRun) {
        lastCall.push({ phone: row.phone, sent: false, kind: stillOk ? "alive(dry)" : "unavailable(dry)" });
        continue;
      }

      const sr = await sendTextMessage(row.phone, message, env);
      await markDone();
      if (sr.ok) {
        try {
          await env.DB.prepare(
            `INSERT INTO whatsapp_messages (meta_message_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
             VALUES (?, 'out', ?, ?, ?, ?, 0, 'sent')`,
          ).bind(sr.messageId ?? null, env.WHATSAPP_PHONE_NUMBER_ID, row.phone, message, stillOk ? "last_call" : "last_call_redirect").run();
        } catch { /* best-effort */ }
      }
      lastCall.push({ phone: row.phone, sent: sr.ok, kind: stillOk ? "alive" : "unavailable", error: sr.ok ? undefined : sr.error });
    }
  } catch (err) {
    lastCall.push({ phone: "—", sent: false, error: `lastCall: ${(err as Error).message}` });
  }

  return json({
    ok: true,
    candidates: rows.length,
    sent: results.filter((r) => r.sent).length,
    lastCall: { processed: lastCall.length, sent: lastCall.filter((r) => r.sent).length, detail: lastCall },
    dryRun,
    results,
  });
};
