/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/bot-retry
//
// AUTO-RECUPERACIÓN del bot. Cuando el LLM (Workers AI) tiene un hipo y el bot no
// puede responder, el webhook NO queda mudo para siempre: encola la conversación en
// bot_retry_queue. Este cron (cada ~2 min) reprocesa el ÚLTIMO mensaje del cliente;
// cuando el LLM se recupera (casi siempre en minutos), el bot RESPONDE SOLO y retoma
// la conversación. Solo escala a César por email si tras MAX_ATTEMPTS sigue caído.
//
// Decisión de César: "que no diga nada si falla, pero que se recupere y tome la
// conversación". Invierte la lógica vieja (que escalaba al primer glitch): ahora
// escalar es el ÚLTIMO recurso.
//
// Auth: Authorization: Bearer <CRON_SECRET>. Respuesta SIEMPRE 200 con detalle JSON.
//
import { requireBearerAuth } from "../../_lib/admin-auth";
import { todayHn } from "../../_lib/dates";
import { findActiveReservation } from "../../_lib/whatsapp-bot";
import { handleQuoteIncoming, type QuoteFlowEnv } from "../../_lib/quote-flow";
import { sendTextMessage, sendImageMessage, type WhatsAppEnv } from "../../_lib/whatsapp";
import { sendEscalationEmail } from "../../_lib/whatsapp-escalation";
import { pauseBot } from "../../_lib/bot-pause";

type Env = QuoteFlowEnv & WhatsAppEnv & {
  CRON_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
};

/** Conversaciones a reprocesar por tick (controla tiempo/costo). Bajo a propósito:
 *  cada reproceso golpea la IA, y un lote grande la satura (círculo vicioso). */
const BATCH = 3;
/** Tras cuántos intentos fallidos seguidos escalar a César. Con cron cada 2 min,
 *  ~6 intentos ≈ 12 min de auto-recuperación antes de pedir ayuda humana. */
const MAX_ATTEMPTS = 6;

/** Mismas reglas de handoff que el webhook (mantener en sync). Si el reproceso cae
 *  en una de estas, un humano toma la conversación → pausamos el bot. */
const HANDOFF_RULES = new Set<string>([
  // out_of_scope_redirect SACADO (en sync con el webhook, César 2026-06-11): ya no es handoff.
  "existing_guest_escalation",
  "long_term_inquiry",
  "payment_reported",
  "transfer_proof_received",
  "paypal_usd_requested",
  "escalar_humano",
]);

interface QueueRow { phone: string; last_in_id: string | null; attempts: number; }
interface InRow { meta_message_id: string | null; body: string | null; created_at: string; }

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  // Latido (para el Centro de Control).
  try {
    await env.DB.prepare(
      `INSERT INTO system_heartbeat (key, last_at) VALUES ('cron_bot_retry', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
    ).run();
  } catch { /* best-effort */ }

  // ── FRENO (circuit breaker): si la IA falló hace muy poco, NO reproceses ──
  // Reintentar mientras Workers AI está saturado/caído solo lo empeora: es un
  // círculo vicioso (el reproceso golpea la IA → falla → reencola → la golpea
  // más → nunca se libera). Si hubo un error del LLM en los últimos 3 min,
  // saltamos el ciclo para que la IA respire. Cuando se recupere (sin errores
  // recientes), el cron reanuda solo en el próximo tick.
  try {
    const recentErr = await env.DB
      .prepare(
        `SELECT 1 AS x FROM system_heartbeat
          WHERE key = 'bot_llm_error' AND last_at > datetime('now','-3 minutes')`,
      )
      .first<{ x: number }>();
    if (recentErr) {
      return json({ ok: true, skipped: "LLM con error reciente (<3 min) — ciclo omitido para no saturar la IA" });
    }
  } catch { /* best-effort: si el chequeo falla, seguimos normal */ }

  let queue: QueueRow[] = [];
  try {
    const res = await env.DB
      .prepare(`SELECT phone, last_in_id, attempts FROM bot_retry_queue ORDER BY created_at LIMIT ?`)
      .bind(BATCH)
      .all<QueueRow>();
    queue = res.results ?? [];
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` });
  }

  const today = todayHn();
  const del = (phone: string) =>
    env.DB.prepare(`DELETE FROM bot_retry_queue WHERE phone = ?`).bind(phone).run().catch(() => {});
  const results: Array<Record<string, unknown>> = [];

  for (const row of queue) {
    const phone = row.phone;

    // Último mensaje entrante del cliente (el que hay que reprocesar).
    const lastIn = await env.DB
      .prepare(
        `SELECT meta_message_id, body, created_at FROM whatsapp_messages
          WHERE from_phone = ? AND direction = 'in'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .bind(phone)
      .first<InRow>()
      .catch(() => null);

    if (!lastIn || !lastIn.body) { await del(phone); results.push({ phone, skipped: "sin mensaje" }); continue; }

    // ¿Ya hay respuesta del bot posterior? (el cliente reescribió y el webhook
    // respondió, o un tick previo lo resolvió) → nada que hacer.
    const laterOut = await env.DB
      .prepare(`SELECT 1 AS x FROM whatsapp_messages WHERE to_phone = ? AND direction = 'out' AND created_at > ? LIMIT 1`)
      .bind(phone, lastIn.created_at)
      .first<{ x: number }>()
      .catch(() => null);
    if (laterOut) { await del(phone); results.push({ phone, resolved: "respuesta posterior" }); continue; }

    // ¿Un humano tomó la conversación (bot pausado)? → no reintentar.
    const paused = await env.DB
      .prepare(`SELECT 1 AS x FROM bot_pauses WHERE phone = ?`)
      .bind(phone)
      .first<{ x: number }>()
      .catch(() => null);
    if (paused) { await del(phone); results.push({ phone, skipped: "bot en pausa" }); continue; }

    // Reprocesar el mensaje con el quote flow (que reintenta el LLM internamente).
    const reservation = await findActiveReservation(phone, env.DB, today).catch(() => null);
    let result = null;
    try {
      result = await handleQuoteIncoming(phone, String(lastIn.body), today, env, !!reservation);
    } catch { result = null; }

    if (result && !result.silent && result.reply) {
      // ✅ El LLM se recuperó: el bot responde solo y retoma la conversación.
      const sent = await sendTextMessage(phone, result.reply, env);
      if (result.images && result.images.length > 0) {
        for (const img of result.images) { await sendImageMessage(phone, img, env).catch(() => {}); }
      }
      try {
        await env.DB
          .prepare(
            `INSERT INTO whatsapp_messages (meta_message_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
             VALUES (?, 'out', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            sent.messageId ?? null,
            env.WHATSAPP_PHONE_NUMBER_ID ?? null,
            phone,
            sent.ok ? result.reply : `[FAILED] ${result.reply}\n\nERROR: ${sent.error ?? ""}`,
            result.ruleName,
            result.escalateToOwner ? 1 : 0,
            sent.ok ? "sent" : "failed",
          )
          .run();
      } catch { /* best-effort */ }

      if (result.ruleName && HANDOFF_RULES.has(result.ruleName)) {
        await pauseBot(phone, result.ruleName, env.DB).catch(() => {});
      }
      if (result.escalateToOwner) {
        await sendEscalationEmail(
          { guestMessage: String(lastIn.body), guestPhone: phone, reservation, reason: `Quote flow (reintento): ${result.ruleName}` },
          { RESEND_API_KEY: env.RESEND_API_KEY ?? "", EMAIL_FROM: env.EMAIL_FROM ?? "", EMAIL_REPLY_TO: env.EMAIL_REPLY_TO, WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID },
        ).catch(() => {});
      }
      await del(phone);
      results.push({ phone, recovered: true, sent: sent.ok });
      continue;
    }

    // ❌ Sigue glitcheando → contar intento; escalar SOLO si agotó los reintentos.
    const attempts = (row.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      try {
        await env.DB
          .prepare(`UPDATE whatsapp_messages SET escalated = 1 WHERE meta_message_id = ? AND direction = 'in'`)
          .bind(lastIn.meta_message_id)
          .run();
      } catch { /* best-effort */ }
      await sendEscalationEmail(
        {
          guestMessage: String(lastIn.body),
          guestPhone: phone,
          reservation,
          reason: "⚠️ El bot intentó recuperarse varias veces pero el LLM (Workers AI) sigue sin responder. El cliente quedó sin respuesta — atendelo a mano. El modelo de IA está fallando de forma sostenida.",
        },
        { RESEND_API_KEY: env.RESEND_API_KEY ?? "", EMAIL_FROM: env.EMAIL_FROM ?? "", EMAIL_REPLY_TO: env.EMAIL_REPLY_TO, WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID },
      ).catch(() => {});
      await del(phone);
      results.push({ phone, escalated: true, attempts });
    } else {
      await env.DB
        .prepare(`UPDATE bot_retry_queue SET attempts = ?, last_attempt_at = datetime('now') WHERE phone = ?`)
        .bind(attempts, phone)
        .run()
        .catch(() => {});
      results.push({ phone, retrying: true, attempts });
    }
  }

  return json({ ok: true, processed: queue.length, results });
};
