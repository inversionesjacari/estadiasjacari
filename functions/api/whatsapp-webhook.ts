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
import { sendTextMessage, sendImageMessage } from "../_lib/whatsapp";
import { getCheckinInfo } from "../_lib/checkin-info";
import { todayHn } from "../_lib/dates";
import { matchBotRule, buildEscalationReply, findActiveReservation } from "../_lib/whatsapp-bot";
import { sendEscalationEmail } from "../_lib/whatsapp-escalation";
import { verifyMetaSignature } from "../_lib/meta-signature";
import { handleQuoteIncoming, cancelQuoteFlow } from "../_lib/quote-flow";

interface Env {
  DB: D1Database;
  // WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
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
// También llegan eventos `statuses` (sent/delivered/read de mensajes salientes).
// Esos los ignoramos por ahora.
// ─────────────────────────────────────────────────────────────────────────────

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
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
      if (!value?.messages) continue; // statuses, etc.
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
  if (msg.type !== "text") {
    // Por ahora solo manejamos texto. Audios/imagenes/stickers → escalar genérico.
    await handleNonTextMessage(msg, contacts, env);
    return;
  }
  const bodyText = msg.text?.body?.trim();
  if (!bodyText) return;

  const fromE164 = normalizePhone(msg.from).e164;
  if (!isValidE164(fromE164)) {
    console.error(`Teléfono inválido del entrante: ${msg.from}`);
    return;
  }

  const toE164 = env.WHATSAPP_PHONE_NUMBER_ID ?? "unknown";
  const contactName = contacts[0]?.profile?.name ?? null;

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

  const quoteResult = await handleQuoteIncoming(fromE164, bodyText, today, {
    DB:                   env.DB,
    AI:                   env.AI,
    PAYPAL_API_BASE:      env.PAYPAL_API_BASE,
    PAYPAL_CLIENT_ID:     env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
  }, /* hasActiveReservation: */ !!reservation);

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

  // ── Enviar respuesta por WhatsApp ──────────────────────────────────────
  const sendResult = await sendTextMessage(fromE164, replyText, env);

  // Si el quote flow devolvió fotos, enviarlas después del texto (en orden).
  // Secuencial para que lleguen ordenadas (01, 02, 03, 04).
  if (quoteResult?.images && quoteResult.images.length > 0) {
    for (const imageUrl of quoteResult.images) {
      const imgResult = await sendImageMessage(fromE164, imageUrl, env);
      if (!imgResult.ok) {
        console.error(`Error enviando foto ${imageUrl}:`, imgResult.error);
      }
    }
  }

  const photoNote =
    quoteResult?.images && quoteResult.images.length > 0
      ? `\n[📸 ${quoteResult.images.length} fotos enviadas]`
      : "";
  try {
    await env.DB.prepare(
      `INSERT INTO whatsapp_messages
         (meta_message_id, reservation_id, direction, from_phone, to_phone, body, matched_rule, escalated)
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?)`,
    )
      .bind(
        sendResult.messageId ?? null,
        reservation?.id ?? null,
        toE164,
        fromE164,
        sendResult.ok ? replyText + photoNote : `[FAILED] ${replyText}\n\nERROR: ${sendResult.error}`,
        ruleName,
        escalate ? 1 : 0,
      )
      .run();
  } catch (logErr) {
    console.error("Error guardando mensaje saliente:", (logErr as Error).message);
  }

  // ── Escalación por email ───────────────────────────────────────────────
  if (escalate) {
    const escResult = await sendEscalationEmail(
      {
        guestMessage: bodyText,
        guestPhone: fromE164,
        reservation,
        reason: quoteResult?.escalateToOwner
          ? `Quote flow: ${quoteResult.ruleName} — Cliente quiere reservar / mandar link de pago`
          : ruleName === "escalar_humano"
            ? "El huésped pidió hablar con un humano"
            : reservation
              ? "Bot no pudo matchear ninguna regla"
              : "Mensaje desde un número sin reserva activa",
      },
      {
        RESEND_API_KEY: env.RESEND_API_KEY ?? "",
        EMAIL_FROM: env.EMAIL_FROM ?? "",
        EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
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

  // Nota sobre `contactName`: si quisiéramos personalizar el saludo del bot
  // usando el nombre del perfil de WhatsApp, vendría en contacts[0].profile.name.
  // Por ahora preferimos el guest_name de la reserva (más confiable).
  void contactName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mensajes no-texto (audio, imagen, sticker, etc.)
// ─────────────────────────────────────────────────────────────────────────────

async function handleNonTextMessage(
  msg: MetaMessage,
  contacts: MetaContact[],
  env: Env,
): Promise<void> {
  if (!msg.id || !msg.from) return;
  const fromE164 = normalizePhone(msg.from).e164;
  if (!isValidE164(fromE164)) return;

  // Idempotencia
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO whatsapp_messages
       (meta_message_id, direction, from_phone, to_phone, body)
     VALUES (?, 'in', ?, ?, ?)`,
  )
    .bind(msg.id, fromE164, env.WHATSAPP_PHONE_NUMBER_ID ?? "unknown", `[${msg.type ?? "?"} no manejado]`)
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) return;

  // Responder genérico y escalar
  const reply = `Recibí tu mensaje (audio/imagen/multimedia). Por ahora solo respondo texto — un agente humano te va a atender en breve. Si es urgente, escríbelo en texto o llama al +504 8839-0145.`;
  await sendTextMessage(fromE164, reply, env);

  const reservation = await findActiveReservation(fromE164, env.DB, todayHn());
  await sendEscalationEmail(
    {
      guestMessage: `[Tipo de mensaje no manejado: ${msg.type ?? "desconocido"}]`,
      guestPhone: fromE164,
      reservation,
      reason: `Mensaje multimedia (${msg.type ?? "?"}) — bot no maneja audio/imagen todavía`,
    },
    {
      RESEND_API_KEY: env.RESEND_API_KEY ?? "",
      EMAIL_FROM: env.EMAIL_FROM ?? "",
      EMAIL_REPLY_TO: env.EMAIL_REPLY_TO,
    },
  );

  void contacts;
}
