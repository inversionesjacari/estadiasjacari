/// <reference types="@cloudflare/workers-types" />
//
// Orquestador del quote flow — conecta el bot conversacional, el state machine
// y los helpers de cotización/pago.
//
// Punto de entrada: `handleQuoteIncoming` — se llama desde el webhook DESPUÉS
// de validar la firma y hacer INSERT del mensaje, ANTES del matching de reglas.
//
// Retorna:
//   - { reply, escalateToOwner, ruleName, tokensUsed } → responder al huésped
//   - null → no aplica, dejar que el webhook haga matching normal
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import {
  runConversationalBot,
  getConversationHistory,
  type WorkersAIEnv,
} from "./conversational-bot";
import {
  getState,
  upsertState,
  clearState,
  emptyQuoteData,
  isQuoteDataComplete,
  type ConvState,
} from "./quote-state";
import { buildQuote, formatQuoteMessage, type PropertyPricing } from "./quote-builder";
import { buildPricingMap, buildKnowledgeBaseText } from "./kb-store";
import { checkRangeAvailable, type AvailabilityEnv } from "./availability";
import type { PropertySlug } from "./quote-extractor";
import { createPayPalOrder, type PayPalEnv } from "./paypal-checkout";
import {
  buildTransferMessageHNL,
  buildTransferMessageUSD,
  isUsdRequest,
} from "./bank-transfer";
import { getPropertyPhotos, getGalleryUrl } from "./property-photos";
import { T, asLang } from "./i18n";
import type { QuoteData } from "./quote-extractor";

// ─────────────────────────────────────────────────────────────────────────────
// Detectors rápidos (sin LLM)
// ─────────────────────────────────────────────────────────────────────────────

/** Detecta si un texto tiene intención de pedir cotización / precio. */
export function isPriceIntent(text: string): boolean {
  const norm = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡]/g, "")
    .trim();
  const patterns = [
    "precio",
    "cuanto cuesta",
    "cuanto sale",
    "cuanto vale",
    "tarifa",
    "cotizacion",
    "cotizar",
    "cuanto es",
    "valor",
    "que tal sale",
    "que precios",
    "tienen disponibilidad",
    "hay disponibilidad",
    "esta disponible",
    "estan disponibles",
    "reservar",
    "quiero reservar",
    "me interesa rentar",
    "me interesa alquilar",
  ];
  return patterns.some((p) => norm.includes(p));
}

/** Detecta intent de confirmación afirmativa. */
export function isConfirmation(text: string): boolean {
  const norm = text.toLowerCase().trim();
  return /\b(si|sí|claro|por supuesto|ok|dale|confirmo|de acuerdo|perfecto|ya|listo)\b/.test(norm);
}

/** Detecta si el huésped eligió tarjeta/PayPal. */
export function isCardChoice(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(tarjeta|paypal|tdc|tdb|credito|cr[eé]dito|d[eé]bito|link)\b/.test(t);
}

/** Detecta si el huésped eligió transferencia bancaria. */
export function isTransferChoice(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(transferencia|transferir|banco|cuenta|dep[oó]sito|deposito|bac|ach)\b/.test(t);
}

/** Detecta si el huésped reporta que ya hizo el pago (escalar para verificar). */
export function isPaymentReported(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return /\b(ya pague|ya page|ya transferi|hice el deposito|ya deposite|pago realizado|pago hecho|ya hice el pago|envie el comprobante|aqui esta el comprobante|adjunto comprobante)\b/.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ─────────────────────────────────────────────────────────────────────────────

/** Resultado de procesar un mensaje en el quote flow. */
export interface QuoteFlowResult {
  /** Texto a responder por WhatsApp. */
  reply: string;
  /** Si true: escalar a César (mostrar en inbox como urgente). */
  escalateToOwner: boolean;
  /** Nombre de la "regla" para logging. */
  ruleName: string;
  /** Tokens LLM consumidos en este turn (0 si no se llamó). */
  tokensUsed: number;
  /** URLs de imágenes a enviar (fotos de la propiedad). El webhook las manda. */
  images?: string[];
  /** Si true: el webhook NO responde nada (glitch técnico → dejar que el bot se
   *  recupere solo en el próximo mensaje, sin mensaje raro ni escalación). */
  silent?: boolean;
}

export interface QuoteFlowEnv extends WorkersAIEnv, PayPalEnv, AvailabilityEnv {
  DB: D1Database;
}

// ─────────────────────────────────────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Procesa un mensaje entrante en el contexto del quote flow.
 *
 * @param hasActiveReservation  true si el huésped tiene una reserva activa en D1.
 *   Cuando es true y NO hay un quote flow en progreso, retornamos null para que
 *   el rule-based bot maneje al huésped existente (check-in, etc.).
 *   Cuando es false (potencial nuevo huésped) respondemos a CUALQUIER mensaje.
 */
export async function handleQuoteIncoming(
  phone: string,
  text: string,
  todayIso: string,
  env: QuoteFlowEnv,
  hasActiveReservation = false,
): Promise<QuoteFlowResult | null> {
  const existing = await getState(phone, env.DB);

  // Mapa de precios/capacidad desde D1 (editable). Fallback al hardcoded.
  // Se construye una vez por mensaje y se pasa a todos los sub-handlers.
  const pricingMap = await buildPricingMap(env.DB);

  // Idioma del cliente persistido en el estado (para responder en su idioma).
  const lang = asLang(existing?.data.language);

  // ── CASO 1: Sin estado activo ──────────────────────────────────────────────
  if (!existing) {
    // Huésped existente sin quote flow en curso → dejar que el rule-bot responda
    if (hasActiveReservation) return null;
    // Potencial nuevo huésped → siempre iniciar el funnel (cualquier mensaje)
    return gatherQuoteData(phone, text, emptyQuoteData(), todayIso, env, true, pricingMap);
  }

  // ── CASO 2: Quote ya entregado, esperando "sí" ─────────────────────────────
  if (existing.state === "quote_provided") {
    if (isConfirmation(text)) {
      await upsertState(phone, "awaiting_payment_method", existing.data, env.DB);
      const quote = await buildQuote(
        {
          property: existing.data.property!,
          checkIn:  existing.data.checkIn!,
          checkOut: existing.data.checkOut!,
          guests:   existing.data.guests!,
        },
        env.DB,
        pricingMap,
      );
      const depositLine = quote
        ? `*HNL ${quote.depositHNL.toLocaleString("es-HN")}* (≈ USD ${quote.depositUSD.toFixed(2)})`
        : lang === "en" ? "the 50% deposit" : "el 50% de la cotización";
      return {
        reply:           T.askPaymentMethod(lang, depositLine),
        escalateToOwner: false,
        ruleName:        "quote_confirmed_ask_method",
        tokensUsed:      0,
      };
    }
    // No confirmó → volver a recolectar datos (puede haber cambiado fechas)
    return gatherQuoteData(phone, text, existing.data, todayIso, env, false, pricingMap);
  }

  // ── CASO 2.5: Esperando método de pago ────────────────────────────────────
  if (existing.state === "awaiting_payment_method") {
    return handlePaymentMethodChoice(phone, text, existing.data, env, pricingMap);
  }

  // ── CASO 2.6: Esperando captura PayPal ────────────────────────────────────
  if (existing.state === "awaiting_paypal_capture") {
    if (isUsdRequest(text)) {
      await cancelQuoteFlow(phone, env.DB);
      return {
        reply:           T.paypalUsdRequested(lang),
        escalateToOwner: true,
        ruleName:        "paypal_usd_requested",
        tokensUsed:      0,
      };
    }
    return {
      reply:           T.paypalPendingReminder(lang),
      escalateToOwner: false,
      ruleName:        "paypal_pending_reminder",
      tokensUsed:      0,
    };
  }

  // ── CASO 2.7: Esperando comprobante de transferencia ──────────────────────
  if (existing.state === "awaiting_transfer_proof") {
    if (isUsdRequest(text)) {
      const quote = await buildQuote(
        {
          property: existing.data.property!,
          checkIn:  existing.data.checkIn!,
          checkOut: existing.data.checkOut!,
          guests:   existing.data.guests!,
        },
        env.DB,
        pricingMap,
      );
      return {
        reply:           buildTransferMessageUSD(quote?.depositUSD ?? 0, lang),
        escalateToOwner: false,
        ruleName:        "transfer_usd_requested",
        tokensUsed:      0,
      };
    }
    // Cualquier cosa (incluyendo foto/imagen) → escalar al humano para verificar
    await cancelQuoteFlow(phone, env.DB);
    return {
      reply:           T.transferProofReceived(lang),
      escalateToOwner: true,
      ruleName:        "transfer_proof_received",
      tokensUsed:      0,
    };
  }

  // ── CASO 3: awaiting_quote_data — seguir recolectando datos ───────────────
  return gatherQuoteData(phone, text, existing.data, todayIso, env, false, pricingMap);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recolección de datos de cotización vía bot conversacional.
 * Maneja tanto la fase inicial (estado nuevo) como actualizaciones posteriores.
 *
 * @param isFirstMessage true si es el primer mensaje del flow (estado vacío).
 */
async function gatherQuoteData(
  phone: string,
  text: string,
  previousData: QuoteData,
  todayIso: string,
  env: QuoteFlowEnv,
  isFirstMessage: boolean,
  pricingMap: Record<PropertySlug, PropertyPricing>,
): Promise<QuoteFlowResult> {
  // Si es primer mensaje, crear el estado vacío antes de llamar al bot
  if (isFirstMessage) {
    await upsertState(phone, "awaiting_quote_data", emptyQuoteData(), env.DB);
  }

  // ── Base de conocimiento desde D1 (editable). Fallback al hardcoded. ───────
  const kbText = await buildKnowledgeBaseText(env.DB);

  // ── Historial de la conversación → memoria del bot (no repetir preguntas) ──
  const history = await getConversationHistory(phone, env.DB);

  // ── Llamada al bot conversacional (Workers AI / Llama) ────────────────────
  const botResult = await runConversationalBot(text, previousData, todayIso, env, kbText, history);

  if (!botResult.ok) {
    // Glitch técnico de Workers AI: NO respondemos nada (decisión de César).
    // Mejor el silencio que un mensaje raro o una falsa promesa de "un humano
    // te responde". El bot se recupera solo en el próximo mensaje del cliente.
    console.error("conversational-bot glitch (silencioso):", botResult.error);
    return {
      reply: "",
      silent: true,
      escalateToOwner: false,
      ruleName:        "bot_glitch_silent",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // Idioma detectado por el bot (o el guardado previamente). Default "es".
  const lang = asLang(botResult.extractedData.language ?? previousData.language);

  // ── Cliente reporta que ya pagó → escalar a humano para verificar el pago ──
  if (isPaymentReported(text)) {
    return {
      reply:           T.paymentReported(lang),
      escalateToOwner: true,
      ruleName:        "payment_reported",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Huésped existente → escalar a un humano del equipo ────────────────────
  // El que escribe ya tiene reserva (puede venir de otro número que no detectamos).
  // No intentamos resolver datos de su reserva por el bot: lo pasamos a un agente.
  if (botResult.intent === "existing_guest") {
    await cancelQuoteFlow(phone, env.DB);
    return {
      reply:           botResult.reply || T.existingGuest(lang),
      escalateToOwner: true,
      ruleName:        "existing_guest_escalation",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Fuera de alcance / no resoluble → redirigir al cliente + avisar al owner ─
  // El bot ya respondió con la redirección (incluye el WhatsApp del equipo).
  // escalateToOwner=true dispara el email + la etiqueta "escalado" en el inbox.
  // NO cancelamos el flow: si tenía una cotización en curso, puede retomarla.
  if (botResult.intent === "out_of_scope") {
    const fallback =
      lang === "en"
        ? "For that, please message our team directly at +504 9764-9035 → https://wa.me/50497649035 🌴"
        : "Para eso, escribile directo a nuestro equipo al +504 9764-9035 → https://wa.me/50497649035 🌴";
    return {
      reply:           botResult.reply && botResult.reply.trim().length > 0 ? botResult.reply : fallback,
      escalateToOwner: true,
      ruleName:        "out_of_scope_redirect",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Merge: los datos nuevos ganan sobre los previos cuando no son null ─────
  const mergedData: QuoteData = {
    checkIn:      botResult.extractedData.checkIn      ?? previousData.checkIn,
    checkOut:     botResult.extractedData.checkOut     ?? previousData.checkOut,
    guests:       botResult.extractedData.guests       ?? previousData.guests,
    property:     botResult.extractedData.property     ?? previousData.property,
    city:         botResult.extractedData.city         ?? previousData.city,
    paypalOrderId: previousData.paypalOrderId,
    depositUsd:    previousData.depositUsd,
    language:      lang,
  };

  // ── Primer mensaje sin ningún dato (saludo genérico) → bienvenida fija ─────
  // Usamos el mensaje determinístico (formato perfecto garantizado) en vez de
  // depender de cómo el LLM formatee el saludo inicial.
  const noDataYet =
    !mergedData.checkIn &&
    !mergedData.checkOut &&
    !mergedData.guests &&
    !mergedData.property &&
    !mergedData.city;

  if (
    isFirstMessage &&
    noDataYet &&
    botResult.intent !== "asking_question" &&
    botResult.intent !== "requesting_photos"
  ) {
    // Persistir el idioma detectado para los siguientes mensajes.
    await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
    return {
      reply:           T.welcome(lang),
      escalateToOwner: false,
      ruleName:        "quote_welcome",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Pide fotos + sabemos la propiedad → enviar fotos + link a galería ─────
  if (botResult.intent === "requesting_photos" && mergedData.property) {
    const photos = getPropertyPhotos(mergedData.property);
    if (photos.length > 0) {
      // Mantener el state con lo que sepamos para seguir el flujo después
      await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
      const galleryUrl = getGalleryUrl(mergedData.property);
      const intro =
        botResult.reply && botResult.reply.trim().length > 0
          ? botResult.reply.trim()
          : T.photosIntro(lang);
      return {
        reply: `${intro}${T.photosGallery(lang, galleryUrl)}`,
        images: photos,
        escalateToOwner: false,
        ruleName: "photos_sent",
        tokensUsed: botResult.tokensUsed,
      };
    }
  }

  // ── ¿Cotizar? Solo si el mensaje ACTUAL aportó un dato nuevo/distinto ─────
  // Evita el bucle: si los datos ya estaban completos de antes y el cliente
  // manda un saludo ("que onda") o pide alternativas ("¿qué otra tienen?"),
  // NO recotizamos lo mismo — dejamos que el bot conversacional responda.
  const ex = botResult.extractedData;
  const changedQuoteData =
    (ex.property != null && ex.property !== previousData.property) ||
    (ex.checkIn  != null && ex.checkIn  !== previousData.checkIn) ||
    (ex.checkOut != null && ex.checkOut !== previousData.checkOut) ||
    (ex.guests   != null && ex.guests   !== previousData.guests);

  // ── ¿Tenemos todo para cotizar? ───────────────────────────────────────────
  if (isQuoteDataComplete(mergedData) && changedQuoteData) {
    const quote = await buildQuote(
      {
        property: mergedData.property!,
        checkIn:  mergedData.checkIn!,
        checkOut: mergedData.checkOut!,
        guests:   mergedData.guests!,
      },
      env.DB,
      pricingMap,
    );

    if (!quote) {
      return {
        reply: T.quoteBuildError(lang),
        escalateToOwner: true,
        ruleName:        "quote_build_failed",
        tokensUsed:      botResult.tokensUsed,
      };
    }

    // ── Verificación de disponibilidad real (Airbnb iCal + D1) ──────────────
    // CRÍTICO: buildQuote solo mira D1. Acá verificamos también Airbnb para
    // NO cotizar fechas ya reservadas en otra plataforma (doble reserva).
    let availabilityNote = "";
    let escalateUnverified = false;
    if (quote.available) {
      const avail = await checkRangeAvailable(
        mergedData.property!,
        mergedData.checkIn!,
        mergedData.checkOut!,
        env,
      );
      if (avail.verified && !avail.available) {
        // Confirmado: las fechas están ocupadas en Airbnb → NO disponible
        await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
        return {
          reply: T.unavailable(lang, quote.propertyName),
          escalateToOwner: false,
          ruleName: "quote_unavailable_airbnb",
          tokensUsed: botResult.tokensUsed,
        };
      }
      if (!avail.verified) {
        // No pudimos consultar Airbnb → cotizar pero confirmar manualmente
        availabilityNote = T.availabilityNote(lang);
        escalateUnverified = true;
      }
    }

    const quoteMsg = formatQuoteMessage(
      quote,
      {
        property: mergedData.property!,
        checkIn:  mergedData.checkIn!,
        checkOut: mergedData.checkOut!,
        guests:   mergedData.guests!,
      },
      lang,
    );

    // Si el bot también respondió una pregunta, combinar ambas respuestas
    // (ej: "¿Hay piscina? Somos 4 del 15 al 20 en Villa B11")
    const baseReply =
      botResult.intent === "asking_question" && quote.available && !quote.exceedsCapacity
        ? `${botResult.reply}\n\n${quoteMsg}`
        : quoteMsg;
    const reply = baseReply + availabilityNote;

    const nextState: ConvState = quote.available ? "quote_provided" : "awaiting_quote_data";
    await upsertState(phone, nextState, mergedData, env.DB);

    return {
      reply,
      escalateToOwner: escalateUnverified,
      ruleName:        quote.available ? "quote_provided" : "quote_unavailable",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Datos incompletos — usar la respuesta natural del bot ─────────────────
  // El bot ya sabe qué preguntar + puede haber contestado preguntas en el mismo reply
  await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
  return {
    reply:           botResult.reply,
    escalateToOwner: false,
    ruleName:        "bot_gathering_data",
    tokensUsed:      botResult.tokensUsed,
  };
}

/**
 * Maneja la elección de método de pago (tarjeta vs transferencia).
 */
async function handlePaymentMethodChoice(
  phone: string,
  text: string,
  data: QuoteData,
  env: QuoteFlowEnv,
  pricingMap: Record<PropertySlug, PropertyPricing>,
): Promise<QuoteFlowResult> {
  const lang = asLang(data.language);
  const cardChoice     = isCardChoice(text);
  const transferChoice = isTransferChoice(text);

  if (!cardChoice && !transferChoice) {
    return {
      reply:           T.paymentMethodClarify(lang),
      escalateToOwner: false,
      ruleName:        "ask_payment_method_clarify",
      tokensUsed:      0,
    };
  }

  const quote = await buildQuote(
    {
      property: data.property!,
      checkIn:  data.checkIn!,
      checkOut: data.checkOut!,
      guests:   data.guests!,
    },
    env.DB,
    pricingMap,
  );

  if (!quote || !quote.available) {
    await cancelQuoteFlow(phone, env.DB);
    return {
      reply:           T.reservationError(lang),
      escalateToOwner: true,
      ruleName:        "payment_method_quote_fail",
      tokensUsed:      0,
    };
  }

  // ── Sub-flow A: Tarjeta / PayPal ──────────────────────────────────────────
  if (cardChoice) {
    const orderResult = await createPayPalOrder(
      {
        amountUsd:    quote.depositUSD,
        propertySlug: data.property!,
        propertyName: quote.propertyName,
        checkIn:      data.checkIn!,
        checkOut:     data.checkOut!,
        guests:       data.guests!,
        guestPhone:   phone,
      },
      env,
    );

    if (!orderResult.ok || !orderResult.approvalUrl) {
      console.error("PayPal create order failed:", orderResult.error);
      // Fallback automático a transferencia
      await upsertState(phone, "awaiting_transfer_proof", { ...data, depositUsd: quote.depositUSD }, env.DB);
      return {
        reply: T.paypalFallbackToTransfer(lang) + buildTransferMessageHNL(quote.depositHNL, lang),
        escalateToOwner: true,
        ruleName:        "paypal_fallback_to_transfer",
        tokensUsed:      0,
      };
    }

    await upsertState(
      phone,
      "awaiting_paypal_capture",
      { ...data, paypalOrderId: orderResult.orderId, depositUsd: quote.depositUSD },
      env.DB,
    );

    return {
      reply: T.paypalLink(
        lang,
        quote.depositHNL.toLocaleString("es-HN"),
        quote.depositUSD.toFixed(2),
        orderResult.approvalUrl,
        quote.balanceHNL.toLocaleString("es-HN"),
      ),
      escalateToOwner: false,
      ruleName:        "paypal_link_sent",
      tokensUsed:      0,
    };
  }

  // ── Sub-flow B: Transferencia bancaria ────────────────────────────────────
  await upsertState(phone, "awaiting_transfer_proof", { ...data, depositUsd: quote.depositUSD }, env.DB);
  return {
    reply:           buildTransferMessageHNL(quote.depositHNL, lang),
    escalateToOwner: true,
    ruleName:        "transfer_details_sent",
    tokensUsed:      0,
  };
}

/** Cancela el quote flow para un número (cuando el huésped pide hablar con humano). */
export async function cancelQuoteFlow(phone: string, db: D1Database): Promise<void> {
  await clearState(phone, db);
}
