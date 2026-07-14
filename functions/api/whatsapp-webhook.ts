/// <reference types="@cloudflare/workers-types" />
//
// /api/whatsapp-webhook
//
// Endpoint para Meta Cloud API:
//   - GET  → verificación inicial del webhook (hub.verify_token + hub.challenge)
//   - POST → recibe mensajes entrantes del huésped, ejecuta el bot rule-based
//            y responde por WhatsApp con texto libre. Si ninguna regla matchea
//            (o el huésped pide humano), escala por email a César.
//
// Configuración en Meta Developers:
//   - URL: https://estadiasjacari.pages.dev/api/whatsapp-webhook
//   - Verify token: el valor de la env var WHATSAPP_WEBHOOK_VERIFY_TOKEN
//   - Suscribir al campo `messages` del objeto whatsapp_business_account
//
// Idempotencia:
//   Meta puede reintentar webhooks varias veces. Usamos `meta_message_id`
//   UNIQUE en `whatsapp_messages` + INSERT OR IGNORE para procesar cada
//   mensaje del huésped una sola vez.
//
// Respuesta SIEMPRE 200 a Meta (excepto en GET de verificación rechazado).
// Si respondemos error a Meta, va a reintentar exponencialmente, ensuciando
// los logs sin lograr nada. Mejor responder OK y loguear el error localmente.
//

import { normalizePhone, isValidE164 } from "../_lib/phone";
import { sendTextMessage, sendImageMessage, sendProductMessage, sendButtonsMessage } from "../_lib/whatsapp";
import { buttonReplyToText } from "../_lib/button-map";
import { isDuplicateResend, parseSqliteUtcMs } from "../_lib/outbound-dedup";
import { classifyCatalogSend } from "../_lib/catalog-trace";
import { transcribeVoiceNote } from "../_lib/voice-transcribe";
import { getCheckinInfo } from "../_lib/checkin-info";
import { todayHn } from "../_lib/dates";
import { matchBotRule, buildEscalationReply, findActiveReservation, type ActiveReservation } from "../_lib/whatsapp-bot";
import { sendEscalationEmail } from "../_lib/whatsapp-escalation";
import { verifyMetaSignature } from "../_lib/meta-signature";
import { handleQuoteIncoming, cancelQuoteFlow } from "../_lib/quote-flow";
import { pauseBot, isBotPaused } from "../_lib/bot-pause";
import { getState } from "../_lib/quote-state";
import { processTransferReceipt } from "../_lib/receipt";
import { checkRateLimit } from "../_lib/rate-limit";

// Máximo de mensajes por número que DISPARAN al bot (LLM/visión/escalación) por
// minuto. El mensaje entrante SIEMPRE se guarda en el inbox — esto solo frena la
// respuesta automática ante un flood (protege cuota de OpenAI y emails). Con
// "última palabra gana", un humano legítimo nunca se acerca a este límite.
const BOT_RATE_MAX_PER_MIN = 10;

/**
 * true = este número superó el límite y NO debe disparar trabajo caro.
 * checkRateLimit es fail-open (si D1 falla, deja pasar) — nunca calla al bot
 * por un problema del rate limiter.
 */
async function isBotRateLimited(fromE164: string, env: Env): Promise<boolean> {
  const rl = await checkRateLimit(env, {
    endpoint: "webhook/whatsapp",
    ip: fromE164, // clave por teléfono origen, no por IP (la IP es de Meta)
    max: BOT_RATE_MAX_PER_MIN,
    windowSec: 60,
  });
  if (!rl.allowed) {
    console.warn(`Rate limit bot: ${fromE164} lleva ${rl.currentCount} msgs/min — mensaje guardado, sin auto-respuesta`);
  }
  return !rl.allowed;
}

// Reglas que significan "un humano toma la conversación" → pausamos el bot para
// ese número (deja de auto-responder) hasta reactivarlo a mano desde el inbox.
const HANDOFF_RULES = new Set<string>([
  // out_of_scope_redirect SACADO (César, 2026-06-11): pedir otra zona/opción que no
  // tenemos ya NO pausa ni escala — el bot declina, reenfoca y sigue atendiendo solo.
  "existing_guest_escalation",  // huésped existente pide soporte
  "long_term_inquiry",          // renta a largo plazo → César evalúa la propuesta
  "payment_reported",           // cliente dice que ya pagó/transfirió
  "transfer_proof_received",    // mandó comprobante de transferencia
  "paypal_usd_requested",       // pidió el monto en USD del link PayPal
  "escalar_humano",             // pidió hablar con un humano (rule-based)
  "event_inquiry_handoff",      // lead de EVENTO (Valle de Ángeles) → el equipo arma la propuesta
  "transfer_question_escalated", // pregunta sin respuesta determinística esperando comprobante → César la toma
  "human_agent_requested",       // pidió una persona / "no leen mis mensajes" → lo toma un humano
  "payment_help_escalated",      // se trabó en el clarify de pago → lo toma un humano
]);
import type { IcalEnv } from "../_lib/availability";

interface Env extends IcalEnv {
  DB: D1Database;
  OPENAI_API_KEY?: string; // visión para leer comprobantes de transferencia
  // WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_CATALOG_ID?: string;
  WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;
  /**
   * App Secret de la app de Meta (Developers → App → Settings → Basic →
   * App Secret). Usado para verificar `x-hub-signature-256` en cada POST
   * del webhook. SIN esto, cualquiera puede POSTear payloads falsos y
   * disparar emails, respuestas del bot, escritura en D1, etc.
   */
  WHATSAPP_APP_SECRET?: string;
  // Sheet (para getCheckinInfo)
  SHEET_WEBHOOK_URL?: string;
  SHEET_WEBHOOK_SECRET?: string;
  // Resend (escalación por email)
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  /**
   * API key de Anthropic — usado por el quote flow para parsear fechas,
   * huéspedes y propiedad con Claude Haiku. Sin esto, el quote flow se
   * salta y el huésped cae a escalation manual (comportamiento previo).
   */
  /**
   * DEPRECATED: antes se usaba Claude para extracción de fechas.
   * Ahora el bot usa Cloudflare Workers AI (binding AI). Si esta var sigue
   * configurada en Cloudflare, no hace daño, simplemente no se usa en este flow.
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * Cloudflare Workers AI binding — usado por el bot conversacional (Llama 3.3).
   * Configurar en Cloudflare Pages → Settings → Functions → AI Bindings
   * con variable name = "AI".
   */
  AI?: Ai;
  // PayPal (reusa env vars del webhook ya configuradas) — para crear órdenes
  // de pago desde el quote flow cuando el huésped confirma con tarjeta.
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — verificación inicial del webhook
// ─────────────────────────────────────────────────────────────────────────────
//
// Meta hace UN GET cuando configuras el webhook con:
//   ?hub.mode=subscribe&hub.verify_token=<el-que-pusiste>&hub.challenge=<string-random>
//
// Si el token matchea nuestra env var, devolvemos el challenge tal cual (text/plain).
// Si no matchea, 403. Esto le confirma a Meta que controlamos esta URL.
// ─────────────────────────────────────────────────────────────────────────────

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe") {
    return new Response("Bad hub.mode", { status: 400 });
  }
  if (!env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new Response("WHATSAPP_WEBHOOK_VERIFY_TOKEN no configurado", { status: 500 });
  }
  if (token !== env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new Response("verify_token no coincide", { status: 403 });
  }
  return new Response(challenge ?? "", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST — mensajes entrantes
// ─────────────────────────────────────────────────────────────────────────────
//
// Payload simplificado de Meta:
// {
//   object: "whatsapp_business_account",
//   entry: [{
//     id: "<WABA id>",
//     changes: [{
//       value: {
//         messaging_product: "whatsapp",
//         metadata: { display_phone_number, phone_number_id },
//         contacts: [{ profile: { name }, wa_id }],
//         messages: [{
//           from: "504...",
//           id: "wamid.XXX",
//           timestamp: "1234567890",
//           type: "text",
//           text: { body: "hola" }
//         }]
//       },
//       field: "messages"
//     }]
//   }]
// }
//
// También llegan eventos `statuses` (sent/delivered/read/failed de salientes):
// los procesa handleStatusUpdate — actualizan los checks (whatsapp_messages.status)
// y los `failed` quedan en bot_trace (WA_DELIVERY_FAILED) con el motivo exacto de
// Meta. Alimentan la card "📬 Salud de entrega" de /inbox/operacion y el check 5
// del watchdog.
// ─────────────────────────────────────────────────────────────────────────────

interface MetaMediaObject {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}
interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMediaObject;
  audio?: MetaMediaObject;
  video?: MetaMediaObject;
  document?: MetaMediaObject;
  sticker?: MetaMediaObject;
  reaction?: { message_id?: string; emoji?: string };
  // Presente cuando el huésped TOCA un botón nativo (interactive reply button).
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  contacts?: Array<{
    name?: { formatted_name?: string; first_name?: string };
    phones?: Array<{ phone?: string; wa_id?: string }>;
  }>;
  // Presente cuando el chat se inició desde un ad "Click to WhatsApp" de Meta:
  // nos dice EXACTAMENTE de qué anuncio/campaña vino el lead.
  referral?: {
    source_url?: string;
    source_id?: string;
    source_type?: string; // 'ad' | 'post'
    headline?: string;
    body?: string;
    media_type?: string;
    ctwa_clid?: string;
  };
}

interface MetaContact {
  profile?: { name?: string };
  wa_id?: string;
}

interface MetaChange {
  field?: string;
  value?: {
    messaging_product?: string;
    metadata?: { display_phone_number?: string; phone_number_id?: string };
    contacts?: MetaContact[];
    messages?: MetaMessage[];
    statuses?: unknown[];
  };
}

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{ id?: string; changes?: MetaChange[] }>;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Filosofía: SIEMPRE responder 200 a Meta. Si respondemos error, Meta reintenta
  // exponencialmente y ensucia los logs sin lograr nada. Toda fail-condition se
  // loguea localmente y termina con 200.

  // 1. Leer raw body — CRÍTICO para verificación HMAC byte-exacta.
  //    JSON.parse + JSON.stringify cambian whitespace/order de keys → firma
  //    diferente → falso negativo.
  const rawBody = await request.text();

  // 2. Verificar firma Meta (x-hub-signature-256).
  //    Sin App Secret configurado → no procesamos (fail closed).
  //    Sin header de firma → no procesamos (request no viene de Meta legítimo).
  //    Firma inválida → no procesamos (posible spoofing).
  if (!env.WHATSAPP_APP_SECRET) {
    console.error(
      "⚠️ WHATSAPP_APP_SECRET no configurado — webhook ignorado por seguridad. " +
        "Configura el env var en Cloudflare Pages → Settings → Environment variables (Encrypted).",
    );
    return new Response("ok", { status: 200 });
  }
  const signatureHeader = request.headers.get("x-hub-signature-256");
  if (!signatureHeader) {
    console.error(
      "⚠️ Webhook POST sin header x-hub-signature-256 — ignorado. " +
        "Esto NO debería pasar si la petición viene de Meta.",
    );
    return new Response("ok", { status: 200 });
  }
  const sigOk = await verifyMetaSignature(rawBody, signatureHeader, env.WHATSAPP_APP_SECRET);
  if (!sigOk) {
    console.error(
      "⚠️ Firma Meta inválida — webhook ignorado (posible spoofing o secret incorrecto).",
    );
    return new Response("ok", { status: 200 });
  }

  // 3. Firma verificada — parsear el body ya validado.
  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody) as MetaWebhookBody;
  } catch (err) {
    console.error("Webhook POST: body firmado pero no es JSON válido:", err);
    return new Response("ok", { status: 200 });
  }

  if (body.object !== "whatsapp_business_account") {
    return new Response("ok", { status: 200 });
  }

  const entries = body.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;

      // Eventos de estado (sent/delivered/read/failed) → actualizar checks ✓✓
      if (value?.statuses) {
        for (const st of value.statuses) {
          try {
            await handleStatusUpdate(st, env);
          } catch (err) {
            const sid = (st as { id?: string })?.id ?? "?";
            console.error(`Error en status ${sid}:`, (err as Error).message);
          }
        }
      }

      if (!value?.messages) continue;
      for (const msg of value.messages) {
        try {
          await processIncomingMessage(msg, value.contacts ?? [], env);
        } catch (err) {
          console.error(
            `Error procesando mensaje ${msg.id ?? "?"}:`,
            (err as Error).message,
          );
        }
      }
    }
  }

  return new Response("ok", { status: 200 });
};

/**
 * Actualiza el estado de entrega de un mensaje saliente (checks de WhatsApp).
 * Meta manda: sent → delivered → read. Usamos un ranking para no "retroceder"
 * (ej. si read llega antes que delivered por orden de red).
 */
async function handleStatusUpdate(stRaw: unknown, env: Env): Promise<void> {
  const st = stRaw as {
    id?: string;
    status?: string;
    recipient_id?: string;
    errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
  };
  const id = st?.id;
  const status = st?.status;
  if (!id || !status) return;
  if (!["sent", "delivered", "read", "failed"].includes(status)) return;

  // Un `failed` de Meta trae el PORQUÉ exacto (código + título + detalle). Lo
  // capturamos SIEMPRE en bot_trace, aunque el mensaje no tenga fila en
  // whatsapp_messages — las alertas a dueños salen por fetch directo (notifyOwners)
  // sin fila propia, así que sin esto el motivo real de "aceptado (200) pero no
  // entregado" se pierde en silencio. (B8, 2026-07-11.)
  if (status === "failed") {
    try {
      const e = st.errors?.[0];
      const detail = `wamid=${id} to=${st.recipient_id ?? "?"} code=${e?.code ?? "?"} ${e?.title ?? ""} :: ${e?.error_data?.details ?? e?.message ?? ""}`;
      await env.DB.prepare(
        `INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'WA_DELIVERY_FAILED', ?)`,
      ).bind(st.recipient_id ?? "", detail.slice(0, 500)).run();
    } catch { /* best-effort */ }
  }

  await env.DB.prepare(
    `UPDATE whatsapp_messages
        SET status = ?
      WHERE meta_message_id = ?
        AND COALESCE(CASE status
              WHEN 'failed' THEN 4 WHEN 'read' THEN 3
              WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END, 0)
          < CASE ?
              WHEN 'failed' THEN 4 WHEN 'read' THEN 3
              WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END`,
  )
    .bind(status, id, status)
    .run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Procesamiento de UN mensaje entrante (idempotente)
// ─────────────────────────────────────────────────────────────────────────────

async function processIncomingMessage(
  msg: MetaMessage,
  contacts: MetaContact[],
  env: Env,
): Promise<void> {
  // Validaciones mínimas
  if (!msg.id || !msg.from) {
    console.error("Mensaje sin id o from — ignorando");
    return;
  }
  if (msg.type === "reaction") {
    // Reacción (emoji sobre un mensaje nuestro): se guarda para verla en el
    // inbox, pero NO dispara respuesta ni escalación — es solo feedback liviano.
    await handleReaction(msg, env);
    return;
  }
  // Botón nativo (interactive button_reply): lo convertimos al TEXTO canónico que
  // los detectors YA reconocen y lo dejamos fluir por el pipeline normal (mismo
  // camino que quien escribe "tarjeta"/"reservar"). Si el tap no mapea a nada
  // conocido, se trata como el resto de lo no-texto (escala a humano). DEBE ir antes
  // del guard `type !== "text"`, si no un botón caería a media→escalación.
  let bodyText: string | undefined;
  if (msg.type === "interactive") {
    const mapped = buttonReplyToText(msg.interactive)?.trim();
    if (!mapped) {
      await handleMediaMessage(msg, contacts, env);
      return;
    }
    bodyText = mapped;
  } else if (msg.type !== "text") {
    // Audio/imagen/video/documento/sticker: guardamos el archivo (para verlo en
    // el inbox) y escalamos a César. El bot no interpreta media.
    await handleMediaMessage(msg, contacts, env);
    return;
  } else {
    bodyText = msg.text?.body?.trim();
  }
  if (!bodyText) return;

  const fromE164 = normalizePhone(msg.from, { assumeAlreadyE164: true }).e164;
  if (!isValidE164(fromE164)) {
    console.error(`Teléfono inválido del entrante: ${msg.from}`);
    return;
  }

  const toE164 = env.WHATSAPP_PHONE_NUMBER_ID ?? "unknown";
  const contactName = contacts[0]?.profile?.name ?? null;

  // ── Guardar/actualizar el nombre de perfil de WhatsApp ─────────────────
  if (contactName) {
    try {
      await env.DB.prepare(
        `INSERT INTO whatsapp_contacts (phone, profile_name, updated_at)
           VALUES (?, ?, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET
           profile_name = excluded.profile_name,
           updated_at   = datetime('now')`,
      )
        .bind(fromE164, contactName)
        .run();
    } catch (err) {
      console.error("Error guardando contacto:", (err as Error).message);
    }
  }

  // ── Origen del lead (ad Click-to-WhatsApp) ─────────────────────────────
  // Meta manda `referral` cuando el chat se inició desde un ad. Guardamos el
  // PRIMERO por teléfono (INSERT OR IGNORE) = la atribución original del lead.
  if (msg.referral && (msg.referral.source_id || msg.referral.source_url)) {
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO whatsapp_lead_source
           (phone, source_type, source_id, source_url, headline, body, ctwa_clid, first_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
        .bind(
          fromE164,
          msg.referral.source_type ?? null,
          msg.referral.source_id ?? null,
          msg.referral.source_url ?? null,
          (msg.referral.headline ?? "").slice(0, 200) || null,
          (msg.referral.body ?? "").slice(0, 300) || null,
          msg.referral.ctwa_clid ?? null,
        )
        .run();
    } catch (err) {
      console.error("Error guardando origen del lead:", (err as Error).message);
    }
  }

  // ── Idempotencia: INSERT OR IGNORE del mensaje entrante ────────────────
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO whatsapp_messages
       (meta_message_id, direction, from_phone, to_phone, body)
     VALUES (?, 'in', ?, ?, ?)`,
  )
    .bind(msg.id, fromE164, toE164, bodyText)
    .run();

  if ((inserted.meta?.changes ?? 0) === 0) {
    // Ya lo procesamos antes — Meta reintentó. Skip.
    return;
  }

  // ── Bot pausado (handoff a humano) → NO auto-respondemos ───────────────────
  // El mensaje entrante ya quedó guardado arriba, así que aparece en el inbox
  // para que lo atienda un humano. El bot se reactiva a mano con "Reactivar bot".
  if (await isBotPaused(fromE164, env.DB)) {
    console.log(`Bot pausado para ${fromE164} — mensaje queda en el inbox, sin auto-respuesta`);
    return;
  }

  // ── Rate limit por número: ante un flood, el mensaje ya quedó en el inbox
  // pero NO disparamos LLM ni respuesta (protege cuota y evita loops de spam).
  if (await isBotRateLimited(fromE164, env)) {
    try {
      await env.DB.prepare(`INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'RATE_LIMITED', ?)`)
        .bind(fromE164, bodyText.slice(0, 60)).run();
    } catch { /* best-effort */ }
    return;
  }

  // ID autoincremental de ESTE mensaje entrante — usado abajo para "última
  // palabra gana": si mientras procesamos llega otro mensaje del mismo número,
  // este webhook NO responde (lo hará el del mensaje más nuevo, con más contexto).
  const currentMsgId = inserted.meta?.last_row_id ?? 0;

  // Chequeo TEMPRANO de "última palabra gana": si ya llegó un mensaje más nuevo
  // de este número, abortamos ANTES de llamar al LLM. Evita saturar Workers AI
  // con llamadas concurrentes que igual se descartarían (reduce el "bot_failed").
  try {
    const newerEarly = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM whatsapp_messages
        WHERE from_phone = ? AND direction = 'in' AND id > ?`,
    )
      .bind(fromE164, currentMsgId)
      .first<{ c: number }>();
    if ((newerEarly?.c ?? 0) > 0) {
      console.log(`(early) mensaje más nuevo de ${fromE164} — omito id ${currentMsgId}`);
      return;
    }
  } catch {
    // si el chequeo falla, seguimos normal
  }

  // ── Contexto del bot: reserva activa + check-in info ────────────────────
  const today = todayHn();
  const reservation = await findActiveReservation(fromE164, env.DB, today);
  let info = null;
  if (reservation) {
    const result = await getCheckinInfo(reservation.property_slug, {
      DB: env.DB,
      SHEET_WEBHOOK_URL: env.SHEET_WEBHOOK_URL,
      SHEET_WEBHOOK_SECRET: env.SHEET_WEBHOOK_SECRET,
    });
    info = result.info;
  }

  // Asociar mensaje a reserva (si la hay) para audit
  if (reservation) {
    try {
      await env.DB.prepare(
        `UPDATE whatsapp_messages SET reservation_id = ? WHERE meta_message_id = ?`,
      )
        .bind(reservation.id, msg.id)
        .run();
    } catch {
      // best-effort
    }
  }

  // ── Bot: quote flow tiene prioridad sobre reglas rule-based ───────────
  //
  // Lógica de routing:
  //   - Huésped SIN reserva activa → siempre entra al quote flow.
  //     El bot responde a cualquier mensaje (saludo, precio, pregunta).
  //   - Huésped CON reserva activa → puede seguir en quote flow si ya
  //     estaba en medio de uno (ej. quiere hacer una 2da reserva).
  //     Si no tiene estado activo, lo maneja el rule-based bot (check-in, etc.)
  //
  const ctx = { reservation, info, todayHn: today };

  let replyText: string;
  let ruleName: string | null;
  let escalate: boolean;

  // 📸 CÁMARA: marcamos que llegamos al procesamiento del bot (antes de la IA).
  try {
    await env.DB.prepare(`INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'PRE_LLM', ?)`)
      .bind(fromE164, bodyText.slice(0, 60)).run();
  } catch { /* best-effort */ }

  // Pasamos `env` completo: incluye DB, AI, PayPal y las AIRBNB_ICAL_* que el
  // quote flow usa para verificar disponibilidad real antes de cotizar.
  let quoteResult: Awaited<ReturnType<typeof handleQuoteIncoming>>;
  try {
    quoteResult = await handleQuoteIncoming(
      fromE164,
      bodyText,
      today,
      env,
      /* hasActiveReservation: */ !!reservation,
    );
  } catch (botErr) {
    // 📸 CÁMARA: el bot LANZÓ una excepción → la guardamos exacta (con stack).
    try {
      await env.DB.prepare(`INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'THREW', ?)`)
        .bind(fromE164, `${(botErr as Error).message} :: ${String((botErr as Error).stack ?? "").slice(0, 500)}`).run();
    } catch { /* best-effort */ }
    return;
  }

  if (quoteResult) {
    // Quote flow tomó este mensaje
    replyText = quoteResult.reply;
    ruleName = quoteResult.ruleName;
    escalate = quoteResult.escalateToOwner;
  } else {
    // Sin quote flow activo — matching de reglas normal
    const match = matchBotRule(bodyText, ctx);
    if (match) {
      replyText = match.reply.replace(/\n?__ESCALATE__\n?/g, "").trim();
      ruleName = match.ruleName;
      escalate = match.reply.includes("__ESCALATE__") || match.ruleName === "escalar_humano";
      // Si el huésped pidió humano explícitamente, cancelamos cualquier quote
      // flow zombie que pudiera estar abierto
      if (escalate) {
        await cancelQuoteFlow(fromE164, env.DB);
      }
    } else {
      replyText = buildEscalationReply(ctx);
      ruleName = null;
      escalate = true;
    }
  }

  // ── Glitch técnico del bot (Workers AI / LLM falló) ───────────────────────
  // Decisión de César: NO le mandamos nada raro al cliente (el bot se recupera en
  // el próximo mensaje). PERO ya no quedamos mudos sin rastro — ese silencio hacía
  // que un cliente quedara huérfano y nadie se enterara. Ahora la red es:
  //   1. marcar la conversación como escalada → salta a "Pendientes" del inbox.
  //   2. dejar latido del error del LLM → el Centro de Control puede pintarlo rojo.
  //   3. avisarte por email (máx 1 cada 30 min, para no spamear ante una racha).
  // Silencio INTENCIONAL (no es un glitch): el bot decide no responder a propósito
  // — ej. un "ok"/"gracias" de cierre cuando ya nos despedimos. NO encolar para
  // reintento ni pintar el Bot IA en rojo: simplemente no mandamos nada.
  if (quoteResult?.silent && quoteResult.ruleName === "closing_ack_silent") {
    return;
  }

  if (quoteResult?.silent) {
    console.error(`Glitch del bot (Workers AI) para ${fromE164} (id ${currentMsgId}) — encolado para auto-recuperación`);

    // AUTO-RECUPERACIÓN (decisión de César): en vez de quedar mudo o escalarte de
    // una, encolamos la conversación. El cron /api/cron/bot-retry reprocesa el último
    // mensaje cada ~2 min; cuando el LLM se recupera, el bot responde SOLO y retoma.
    // Solo te escala si tras varios intentos sigue caído. NO le mandamos nada al
    // cliente ahora (se respeta el silent).
    try {
      await env.DB.prepare(
        `INSERT INTO bot_retry_queue (phone, last_in_id, attempts, created_at)
         VALUES (?, ?, 0, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET last_in_id = excluded.last_in_id`,
      ).bind(fromE164, msg.id).run();
    } catch { /* best-effort */ }

    // Latido del error del LLM → semáforo rojo del Bot IA (visibilidad inmediata).
    try {
      await env.DB.prepare(
        `INSERT INTO system_heartbeat (key, last_at) VALUES ('bot_llm_error', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
      ).run();
    } catch { /* best-effort */ }

    return;
  }

  // ── "Última palabra gana": evitar respuestas duplicadas en ráfagas ──────
  // Si el cliente mandó otro mensaje mientras procesábamos este (mensajes
  // rápidos seguidos), NO respondemos: el webhook del mensaje más nuevo
  // responderá con el contexto completo. Esto elimina el doble "¡Hola!" y
  // respuestas que se pisan cuando alguien escribe varias líneas seguidas.
  try {
    const newer = await env.DB.prepare(
      `SELECT COUNT(*) AS c
         FROM whatsapp_messages
        WHERE from_phone = ? AND direction = 'in' AND id > ?`,
    )
      .bind(fromE164, currentMsgId)
      .first<{ c: number }>();
    if ((newer?.c ?? 0) > 0) {
      console.log(
        `Mensaje más nuevo de ${fromE164} detectado — omito respuesta a id ${currentMsgId} para evitar duplicado.`,
      );
      return;
    }
  } catch {
    // Si el chequeo falla, seguimos y respondemos (mejor responder que callar)
  }

  // ── Dedup de salientes verbatim (ráfaga de concurrencia) ───────────────────
  // Complemento de "última palabra gana": cuando el 2º mensaje del cliente llega
  // DESPUÉS de que el 1º ya respondió (segundos de diferencia), ambos webhooks pasan
  // el chequeo de "hay uno más nuevo" y mandan la MISMA respuesta → doble burbuja
  // (chat Méndez: fotos ×2, check-in ×2, "no disponible" ×2, comprobante ×2). Si ya
  // le mandamos a este cliente el MISMO matched_rule + body hace ≤2 min, NO reenviamos
  // (el `return` también evita re-escalar/re-pausar: el 1º ya lo hizo). Ante cualquier
  // error del chequeo → seguimos y respondemos (mejor responder que callar).
  if (replyText && replyText.trim().length > 0) {
    try {
      const prevOut = await env.DB.prepare(
        `SELECT body, matched_rule AS matchedRule, created_at AS createdAt
           FROM whatsapp_messages
          WHERE to_phone = ? AND direction = 'out' AND body <> ''
          ORDER BY id DESC LIMIT 1`,
      )
        .bind(fromE164)
        .first<{ body: string; matchedRule: string | null; createdAt: string }>();
      const prevMs = prevOut ? parseSqliteUtcMs(prevOut.createdAt) : null;
      if (
        prevOut &&
        prevMs != null &&
        isDuplicateResend(
          { matchedRule: prevOut.matchedRule, body: prevOut.body, createdAtMs: prevMs },
          { matchedRule: ruleName, body: replyText },
          Date.now(),
        )
      ) {
        console.log(
          `Saliente duplicado (${ruleName}) a ${fromE164} — omito reenvío verbatim (ráfaga de concurrencia).`,
        );
        return;
      }
    } catch {
      // Si el chequeo falla, seguimos y respondemos (mejor responder que callar)
    }
  }

  // ── Tarjeta NATIVA de producto (catálogo de WhatsApp) ──────────────────────
  // Si el quote flow pidió una tarjeta de producto Y el catálogo está configurado,
  // la mandamos (imagen + precio + botón "Ver" nativos). Si falla (catálogo no
  // listo, producto inexistente, env sin catalog_id), caemos al texto + fotos de
  // siempre (fallback) — el bot NUNCA queda mudo por esto.
  //
  // INSTRUMENTACIÓN (2026-07-11): cada intento deja una cámara en `bot_trace`
  // (`CATALOG_CARD_SENT` cuando la nativa se comparte de verdad, `CATALOG_CARD_FALLBACK`
  // cuando cae al texto — incluyendo el caso "falta env WHATSAPP_CATALOG_ID"). Así
  // se puede consultar en D1 si el catálogo de Meta se está usando o si el fallback
  // silencioso lo estaba tapando (auditoría doc 11 §3). El helper `classifyCatalogSend`
  // decide qué escribir; el INSERT es best-effort y nunca rompe el envío.
  let productSent = false;
  if (quoteResult?.productCard) {
    const pc = quoteResult.productCard;

    let outcome;
    if (!env.WHATSAPP_CATALOG_ID) {
      outcome = classifyCatalogSend({ retailerId: pc.retailerId, hasCatalogId: false, sendOk: null });
    } else {
      const prodResult = await sendProductMessage(fromE164, pc.retailerId, env, pc.body);
      outcome = classifyCatalogSend({
        retailerId: pc.retailerId,
        hasCatalogId: true,
        sendOk: prodResult.ok,
        messageId: prodResult.messageId,
        error: prodResult.error,
      });
      if (prodResult.ok) {
        productSent = true;
        try {
          await env.DB.prepare(
            `INSERT INTO whatsapp_messages
               (meta_message_id, reservation_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
             VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 'sent')`,
          )
            .bind(
              prodResult.messageId ?? null,
              reservation?.id ?? null,
              toE164,
              fromE164,
              pc.body && pc.body.trim().length > 0 ? pc.body : replyText,
              ruleName,
              escalate ? 1 : 0,
            )
            .run();
        } catch (logErr) {
          console.error("Error guardando producto saliente:", (logErr as Error).message);
        }
      } else {
        console.error(`Producto ${pc.retailerId} no se pudo enviar, fallback a texto:`, prodResult.error);
      }
    }

    // Cámara best-effort: deja el veredicto en bot_trace para poder consultarlo.
    try {
      await env.DB.prepare(`INSERT INTO bot_trace (phone, stage, detail) VALUES (?, ?, ?)`)
        .bind(fromE164, outcome.stage, outcome.detail)
        .run();
    } catch {
      // Nunca romper el envío por no poder escribir la traza.
    }
  }

  // ── Enviar respuesta por WhatsApp (texto + fotos) — salvo que ya se haya
  //    mandado la tarjeta nativa de producto arriba.
  if (!productSent) {
    // previewUrl=true solo cuando el quote flow manda una ubicación (link de Google
    // Maps): así WhatsApp dibuja la miniatura del mapa con el pin debajo del texto.
    // Botones nativos solo si el texto entra en el cuerpo interactivo (Meta lo capa
    // a 1024). Si la cotización es larga, mando texto plano (hasta 4096) para NO
    // truncar el precio — mejor sin botones que con la plata cortada.
    const sendResult = quoteResult?.buttons && quoteResult.buttons.length > 0 && replyText.length <= 1024
      ? await sendButtonsMessage(fromE164, replyText, quoteResult.buttons, env)
      : await sendTextMessage(fromE164, replyText, env, quoteResult?.previewUrl ?? false);

    // Loggear el texto del bot PRIMERO, para que en el inbox quede ANTES de las
    // fotos (mismo orden que las recibe el cliente en WhatsApp).
    try {
      await env.DB.prepare(
        `INSERT INTO whatsapp_messages
           (meta_message_id, reservation_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          sendResult.messageId ?? null,
          reservation?.id ?? null,
          toE164,
          fromE164,
          sendResult.ok ? replyText : `[FAILED] ${replyText}\n\nERROR: ${sendResult.error}`,
          ruleName,
          escalate ? 1 : 0,
          sendResult.ok ? "sent" : "failed",
        )
        .run();
    } catch (logErr) {
      console.error("Error guardando mensaje saliente:", (logErr as Error).message);
    }

    // Si el quote flow devolvió fotos, enviarlas después del texto (en orden) y
    // loggear cada una como su propia burbuja de imagen en el inbox (media_url =
    // URL pública del sitio, no necesita proxy ni token).
    if (quoteResult?.images && quoteResult.images.length > 0) {
      for (const imageUrl of quoteResult.images) {
        const imgResult = await sendImageMessage(fromE164, imageUrl, env);
        if (!imgResult.ok) {
          console.error(`Error enviando foto ${imageUrl}:`, imgResult.error);
        }
        try {
          await env.DB.prepare(
            `INSERT INTO whatsapp_messages
               (meta_message_id, reservation_id, direction, from_phone, to_phone, body, matched_rule, escalated, status, media_type, media_url, media_mime)
             VALUES (?, ?, 'out', ?, ?, '', ?, 0, ?, 'image', ?, 'image/jpeg')`,
          )
            .bind(
              imgResult.messageId ?? null,
              reservation?.id ?? null,
              toE164,
              fromE164,
              ruleName,
              imgResult.ok ? "sent" : "failed",
              imageUrl,
            )
            .run();
        } catch (logErr) {
          console.error("Error guardando foto saliente:", (logErr as Error).message);
        }
      }
    }
  }

  // ── Escalación por email ───────────────────────────────────────────────
  if (escalate) {
    const escResult = await sendEscalationEmail(
      {
        guestMessage: bodyText,
        guestPhone: fromE164,
        reservation,
        reason: quoteResult?.ruleName === "long_term_inquiry"
          ? "Renta a LARGO PLAZO (estadía de un mes o más) — el bot lo pausó para que vos evalúes la propuesta a medida con el cliente."
          : quoteResult?.ruleName === "event_inquiry_handoff"
          ? "🎉 Lead de EVENTO (Valle de Ángeles) — el bot le preguntó tipo/fecha/personas (mirá el chat) y pausó la conversación para que el equipo mande la propuesta."
          : quoteResult?.ruleName === "out_of_scope_redirect"
          ? "Fuera de alcance — el bot redirigió al cliente a tu WhatsApp (+504 9764-9035). Escribile vos si querés cerrarlo."
          : quoteResult?.ruleName === "existing_guest_escalation"
          ? "Huésped existente pidiendo soporte de su estadía"
          : quoteResult?.escalateToOwner
          ? `Quote flow: ${quoteResult.ruleName} — Cliente quiere reservar / mandar link de pago`
          : ruleName === "escalar_humano"
            ? "El huésped pidió hablar con un humano"
            : reservation
              ? "Bot no pudo matchear ninguna regla"
              : "Mensaje desde un número sin reserva activa",
        // Handoff iniciado por una REGLA (el bot ya le prometió un humano al
        // huésped: wifi/llaves/cómo-llegar/soporte/evento/pago/llamada) → siempre
        // pinga, aunque la razón no traiga palabra clave. Solo el fallback "no
        // matcheó ninguna regla" (ruleName null) se clasifica y puede quedar mudo.
        // (Revisión adversaria 2026-07-12, hallazgo ALTA A2.)
        forcePing: ruleName !== null,
      },
      {
        RESEND_API_KEY: env.RESEND_API_KEY ?? "",
        EMAIL_FROM: env.EMAIL_FROM ?? "",
        EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
        WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
        WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
        DB: env.DB, // para que la alerta WhatsApp deje rastro (B8: heartbeat + bot_trace)
      },
    );

    if (!escResult.ok) {
      try {
        await env.DB.prepare(
          `UPDATE whatsapp_messages
              SET escalation_error = ?
            WHERE meta_message_id = ?
              AND direction = 'in'`,
        )
          .bind(escResult.error?.slice(0, 500) ?? "unknown", msg.id)
          .run();
      } catch {
        // ignore
      }
    }
  }

  // ── Handoff a humano → pausar el bot en esta conversación ──────────────────
  // A partir de acá el bot deja de auto-responder a este número; lo atendés vos
  // desde el inbox y lo reactivás con el botón "Reactivar bot".
  if (ruleName && HANDOFF_RULES.has(ruleName)) {
    await pauseBot(fromE164, ruleName, env.DB);
  }

  // Nota sobre `contactName`: si quisiéramos personalizar el saludo del bot
  // usando el nombre del perfil de WhatsApp, vendría en contacts[0].profile.name.
  // Por ahora preferimos el guest_name de la reserva (más confiable).
  void contactName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mensajes no-texto (audio, imagen, sticker, etc.)
// ─────────────────────────────────────────────────────────────────────────────

// Reacciones (emoji sobre un mensaje nuestro). Se guardan para verlas en el
// inbox, pero NO disparan respuesta del bot ni escalación: son feedback liviano,
// no una consulta. (Sin esto, un simple 🙏 haría que el bot conteste y te mande
// un email.)
async function handleReaction(msg: MetaMessage, env: Env): Promise<void> {
  if (!msg.id || !msg.from) return;
  const fromE164 = normalizePhone(msg.from, { assumeAlreadyE164: true }).e164;
  if (!isValidE164(fromE164)) return;
  const emoji = (msg.reaction?.emoji ?? "").trim();
  const body = emoji ? `Reaccionó con ${emoji}` : "Quitó su reacción";
  await env.DB.prepare(
    `INSERT OR IGNORE INTO whatsapp_messages
       (meta_message_id, direction, from_phone, to_phone, body)
     VALUES (?, 'in', ?, ?, ?)`,
  )
    .bind(msg.id, fromE164, env.WHATSAPP_PHONE_NUMBER_ID ?? "unknown", body)
    .run();
}

// Resumen legible de los contactos (vCards) que comparte un cliente.
function formatSharedContacts(
  cards?: Array<{ name?: { formatted_name?: string; first_name?: string }; phones?: Array<{ phone?: string; wa_id?: string }> }>,
): string {
  const list = cards ?? [];
  if (list.length === 0) return "📇 Contacto compartido";
  const parts = list.map((c) => {
    const name = c.name?.formatted_name || c.name?.first_name || "Contacto";
    const phone = c.phones?.[0]?.phone || c.phones?.[0]?.wa_id || "";
    return phone ? `${name} · ${phone}` : name;
  });
  return `📇 Contacto compartido: ${parts.join(" | ")}`;
}

const MEDIA_LABELS: Record<string, string> = {
  image: "📷 Imagen",
  audio: "🎤 Nota de voz",
  video: "🎥 Video",
  document: "📄 Documento",
  sticker: "🌟 Sticker",
};

async function handleMediaMessage(
  msg: MetaMessage,
  contacts: MetaContact[],
  env: Env,
): Promise<void> {
  if (!msg.id || !msg.from) return;
  const fromE164 = normalizePhone(msg.from, { assumeAlreadyE164: true }).e164;
  if (!isValidE164(fromE164)) return;

  // Extraer la referencia al archivo según el tipo de mensaje.
  const rawType = msg.type ?? "";
  const mediaType = ["image", "audio", "video", "document", "sticker"].includes(rawType)
    ? rawType
    : "document";
  const mediaObj =
    msg.image ?? msg.audio ?? msg.video ?? msg.document ?? msg.sticker ?? undefined;
  const mediaId = mediaObj?.id ?? null;
  const mediaMime = mediaObj?.mime_type ?? null;
  const filename = msg.document?.filename ?? null;
  const caption = (msg.image?.caption ?? msg.video?.caption ?? msg.document?.caption ?? "").trim();
  // body = caption si hay; si hay archivo, etiqueta legible del tipo (se oculta
  // bajo el adjunto); si es un tipo raro sin archivo descargable, nota visible.
  const body =
    rawType === "contacts"
      ? formatSharedContacts(msg.contacts)
      : caption || (mediaId ? MEDIA_LABELS[mediaType] : `[${rawType || "mensaje"} no soportado]`) || "[multimedia]";

  // Guardar/actualizar el nombre de perfil de WhatsApp (igual que en texto).
  const contactName = contacts[0]?.profile?.name ?? null;
  if (contactName) {
    try {
      await env.DB.prepare(
        `INSERT INTO whatsapp_contacts (phone, profile_name, updated_at)
           VALUES (?, ?, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET
           profile_name = excluded.profile_name, updated_at = datetime('now')`,
      )
        .bind(fromE164, contactName)
        .run();
    } catch {
      /* ignore */
    }
  }

  // Idempotencia + guardar la referencia al media (lo principal: poder verlo).
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO whatsapp_messages
       (meta_message_id, direction, from_phone, to_phone, body, media_type, media_id, media_mime, media_filename)
     VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(msg.id, fromE164, env.WHATSAPP_PHONE_NUMBER_ID ?? "unknown", body, mediaType, mediaId, mediaMime, filename)
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) return; // ya procesado

  // Si un humano ya tomó la conversación (bot en pausa), no respondemos ni
  // escalamos de nuevo: César ya lo está viendo y ahora puede ver el archivo.
  if (await isBotPaused(fromE164, env.DB)) return;

  // Rate limit por número (comparte presupuesto con los mensajes de texto):
  // un flood de imágenes no debe quemar visión de OpenAI ni inundar de emails.
  // El archivo ya quedó guardado y visible en el inbox.
  if (await isBotRateLimited(fromE164, env)) return;

  // ── Comprobante de transferencia (FOTO) en el paso de pago → leer + verificar ──
  // Si el huésped está esperando confirmar su transferencia y manda una IMAGEN, el bot
  // la lee con visión, la verifica y —si pasa los chequeos— auto-confirma la reserva
  // (bloquea el calendario). Dudoso/same-day → escala a César. Otros media o sin estado
  // de pago caen al manejo genérico de abajo.
  if (mediaType === "image" && mediaId) {
    let state = null;
    try { state = await getState(fromE164, env.DB); } catch { /* ignore */ }
    if (state?.state === "awaiting_transfer_proof") {
      const escalateToOwner = async (rule: string) => {
        try { await env.DB.prepare(`UPDATE whatsapp_messages SET escalated = 1 WHERE meta_message_id = ? AND direction = 'in'`).bind(msg.id).run(); } catch { /* ignore */ }
        try { await pauseBot(fromE164, rule, env.DB); } catch { /* ignore */ }
      };
      try {
        const res = await processTransferReceipt({ phone: fromE164, mediaId, mediaMime, state, guestName: contactName, env });
        const send = await sendTextMessage(fromE164, res.replyText, env);
        try {
          await env.DB.prepare(
            `INSERT INTO whatsapp_messages
               (meta_message_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
             VALUES (?, 'out', ?, ?, ?, ?, ?, ?)`,
          ).bind(send.messageId ?? null, env.WHATSAPP_PHONE_NUMBER_ID ?? "unknown", fromE164, res.replyText, res.ruleName, res.escalate ? 1 : 0, send.ok ? "sent" : "failed").run();
        } catch { /* best-effort */ }
        if (res.escalate) {
          await escalateToOwner(res.ruleName);
          // Push a César + socio (email + WhatsApp). Armamos la reserva con los datos del
          // ESTADO (property/fechas/huésped) — NO con findActiveReservation, que no encuentra
          // las reservas 'pending' a futuro → así el aviso lleva los datos reales para verificar.
          try {
            const reservation: ActiveReservation | null =
              state.data.property && state.data.checkIn && state.data.checkOut
                ? {
                    id: 0,
                    property_slug: state.data.property,
                    check_in: state.data.checkIn,
                    check_out: state.data.checkOut,
                    guest_name: contactName ?? null,
                    guest_email: null,
                    guest_phone_normalized: fromE164,
                  }
                : null;
            await sendEscalationEmail(
              {
                guestMessage: "Mandó comprobante de transferencia — verificá el pago en el banco y confirmá la reserva en el inbox.",
                guestPhone: fromE164,
                reservation,
                reason: "💳 Comprobante de transferencia para verificar",
                forcePing: true, // es plata en la mano: siempre suena el teléfono
              },
              {
                RESEND_API_KEY: env.RESEND_API_KEY ?? "",
                EMAIL_FROM: env.EMAIL_FROM ?? "",
                EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
                WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
                WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
                DB: env.DB, // B8: rastro de la alerta WhatsApp
              },
            );
          } catch { /* best-effort */ }
        }
        console.log(`Comprobante (${fromE164}): ${res.summary}`);
      } catch (err) {
        // Fail-soft: ante CUALQUIER error, nunca confirmar en falso → escalar a César.
        console.error("processTransferReceipt error:", (err as Error).message);
        await sendTextMessage(fromE164, "¡Recibido! 🙏 Estamos validando tu comprobante y te confirmamos en un momento.", env);
        await escalateToOwner("transfer_review");
      }
      return;
    }
  }

  // ── Nota de voz → transcribir para LEERLA, no escucharla (B6) ───────────────
  // En Honduras se manda muchísimo audio y hoy toda nota de voz escala a ciegas.
  // La transcribimos con Workers AI: queda como texto en el cuerpo del mensaje
  // (visible + buscable en el inbox) y va en la alerta, para que César responda
  // sin abrir el audio. A propósito NO deja que el bot conteste solo (una
  // transcripción imperfecta daría respuestas malas): sigue escalando a humano.
  // Fail-soft: si Whisper no está o falla, `voiceText` queda null y el escalado
  // de abajo sale genérico igual que hoy (cero regresión).
  let voiceText: string | null = null;
  if (mediaType === "audio" && mediaId) {
    const tr = await transcribeVoiceNote(mediaId, env);
    if (tr.ok) {
      voiceText = tr.text;
      try {
        await env.DB.prepare(
          `UPDATE whatsapp_messages SET body = ? WHERE meta_message_id = ? AND direction = 'in'`,
        ).bind(`🎤 ${voiceText}`, msg.id).run();
      } catch { /* best-effort: la transcripción en la alerta ya aporta */ }
    }
  }

  // El bot no interpreta audio/imagen — avisa cálido y escala para que César
  // lo vea en el inbox (clave para comprobantes de pago).
  const ackText = "¡Recibido! 🌴 En un momento una persona del equipo te atiende por aquí.";
  const ackResult = await sendTextMessage(fromE164, ackText, env);
  // Loggear el saliente del bot para que aparezca en el inbox (antes el "¡Recibido!"
  // se enviaba pero NO se guardaba → en el inbox se veía el media del cliente pero
  // no la respuesta del bot).
  try {
    await env.DB.prepare(
      `INSERT INTO whatsapp_messages
         (meta_message_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
       VALUES (?, 'out', ?, ?, ?, 'media_received', 0, ?)`,
    )
      .bind(ackResult.messageId ?? null, env.WHATSAPP_PHONE_NUMBER_ID ?? "unknown", fromE164, ackText, ackResult.ok ? "sent" : "failed")
      .run();
  } catch {
    /* best-effort */
  }

  const reservation = await findActiveReservation(fromE164, env.DB, todayHn());

  // ── ¿Suena el teléfono por esta media, o basta el email + inbox? ─────────────
  // (César, 2026-07-12: "que solo me llame para lo estrictamente necesario".) Se
  // FUERZA el ping solo donde el email no basta y podría ser plata/humano:
  //   • Nota de voz que NO se pudo transcribir → César no puede leerla; podría ser
  //     un pedido de humano o de pago hablado. (Rev. adversaria, hallazgo M1.)
  //   • Foto/documento de alguien que YA está transaccionando (tiene reserva o un
  //     flujo de cotización/pago abierto) → casi siempre es un comprobante suelto,
  //     común en Honduras mandarlo sin caption. Una foto de un lead FRÍO (sin reserva
  //     ni flujo) sí queda muda: ese es el ruido que César pidió callar. (Hallazgo A1.)
  // El resto (video/sticker/contacto) y la voz transcrita se clasifican por texto.
  const voiceUnreadable = mediaType === "audio" && !voiceText;
  let hasOpenFlow = false;
  if (!reservation && (mediaType === "image" || mediaType === "document")) {
    try { hasOpenFlow = !!(await getState(fromE164, env.DB)); } catch { /* best-effort */ }
  }
  const looksLikeReceipt =
    (mediaType === "image" || mediaType === "document") && (!!reservation || hasOpenFlow);

  await sendEscalationEmail(
    {
      guestMessage: voiceText
        ? `🎤 Nota de voz: "${voiceText}"`
        : rawType === "contacts" ? body : caption ? `[${mediaType}] ${caption}` : `[${MEDIA_LABELS[mediaType] ?? "archivo"} recibido]`,
      guestPhone: fromE164,
      reservation,
      reason: voiceText
        ? "El cliente mandó una nota de voz (transcrita abajo) — respondele"
        : rawType === "contacts" ? "El cliente compartió un contacto — míralo en el inbox" : `El cliente mandó ${MEDIA_LABELS[mediaType] ?? "un archivo"} — míralo en el inbox`,
      forcePing: voiceUnreadable || looksLikeReceipt,
    },
    {
      RESEND_API_KEY: env.RESEND_API_KEY ?? "",
      EMAIL_FROM: env.EMAIL_FROM ?? "",
      EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
      WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
      DB: env.DB, // B8: rastro de la alerta WhatsApp
    },
  );
}
