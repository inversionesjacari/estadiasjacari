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

import { runConversationalBot, type WorkersAIEnv } from "./conversational-bot";
import {
  getState,
  upsertState,
  clearState,
  emptyQuoteData,
  isQuoteDataComplete,
  INITIAL_QUOTE_MESSAGE,
  type ConvState,
} from "./quote-state";
import { buildQuote, formatQuoteMessage } from "./quote-builder";
import { createPayPalOrder, type PayPalEnv } from "./paypal-checkout";
import {
  buildTransferMessageHNL,
  buildTransferMessageUSD,
  isUsdRequest,
} from "./bank-transfer";
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
}

export interface QuoteFlowEnv extends WorkersAIEnv, PayPalEnv {
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

  // ── CASO 1: Sin estado activo ──────────────────────────────────────────────
  if (!existing) {
    // Huésped existente sin quote flow en curso → dejar que el rule-bot responda
    if (hasActiveReservation) return null;
    // Potencial nuevo huésped → siempre iniciar el funnel (cualquier mensaje)
    return gatherQuoteData(phone, text, emptyQuoteData(), todayIso, env, true);
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
      );
      const depositLine = quote
        ? `*HNL ${quote.depositHNL.toLocaleString("es-HN")}* (≈ USD ${quote.depositUSD.toFixed(2)})`
        : "el 50% de la cotización";
      return {
        reply: `¡Excelente! 🎉 ¿Cómo preferís pagar el depósito de ${depositLine}?

💳 *Tarjeta o PayPal* — link inmediato, confirmás al instante
🏦 *Transferencia bancaria* — BAC, te paso los datos

Decime cuál preferís.`,
        escalateToOwner: false,
        ruleName:        "quote_confirmed_ask_method",
        tokensUsed:      0,
      };
    }
    // No confirmó → volver a recolectar datos (puede haber cambiado fechas)
    return gatherQuoteData(phone, text, existing.data, todayIso, env, false);
  }

  // ── CASO 2.5: Esperando método de pago ────────────────────────────────────
  if (existing.state === "awaiting_payment_method") {
    return handlePaymentMethodChoice(phone, text, existing.data, env);
  }

  // ── CASO 2.6: Esperando captura PayPal ────────────────────────────────────
  if (existing.state === "awaiting_paypal_capture") {
    if (isUsdRequest(text)) {
      await cancelQuoteFlow(phone, env.DB);
      return {
        reply:           "Te conecto con un agente que te da la cuenta en USD. 🙏",
        escalateToOwner: true,
        ruleName:        "paypal_usd_requested",
        tokensUsed:      0,
      };
    }
    return {
      reply: "Estoy esperando la confirmación del pago desde PayPal. Una vez procesado, recibís la confirmación automáticamente. Si preferís cambiar a transferencia, decime *transferencia*.",
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
      );
      return {
        reply:           buildTransferMessageUSD(quote?.depositUSD ?? 0),
        escalateToOwner: false,
        ruleName:        "transfer_usd_requested",
        tokensUsed:      0,
      };
    }
    // Cualquier cosa (incluyendo foto/imagen) → escalar al humano para verificar
    await cancelQuoteFlow(phone, env.DB);
    return {
      reply:           "Recibí tu comprobante. Un agente lo revisa y confirma tu reserva en breve. 🙏",
      escalateToOwner: true,
      ruleName:        "transfer_proof_received",
      tokensUsed:      0,
    };
  }

  // ── CASO 3: awaiting_quote_data — seguir recolectando datos ───────────────
  return gatherQuoteData(phone, text, existing.data, todayIso, env, false);
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
): Promise<QuoteFlowResult> {
  // Si es primer mensaje, crear el estado vacío antes de llamar al bot
  if (isFirstMessage) {
    await upsertState(phone, "awaiting_quote_data", emptyQuoteData(), env.DB);
  }

  // ── Llamada al bot conversacional (Workers AI / Llama) ────────────────────
  const botResult = await runConversationalBot(text, previousData, todayIso, env);

  if (!botResult.ok) {
    console.error("conversational-bot failed:", botResult.error);
    return {
      reply: "Disculpa, tuve un problema técnico procesando tu mensaje. Un agente humano te responde en breve. 🙏",
      escalateToOwner: true,
      ruleName:        "bot_failed",
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

  if (isFirstMessage && noDataYet && botResult.intent !== "asking_question") {
    return {
      reply:           INITIAL_QUOTE_MESSAGE,
      escalateToOwner: false,
      ruleName:        "quote_welcome",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── ¿Tenemos todo para cotizar? ───────────────────────────────────────────
  if (isQuoteDataComplete(mergedData)) {
    const quote = await buildQuote(
      {
        property: mergedData.property!,
        checkIn:  mergedData.checkIn!,
        checkOut: mergedData.checkOut!,
        guests:   mergedData.guests!,
      },
      env.DB,
    );

    if (!quote) {
      return {
        reply: "Disculpa, hubo un problema generando tu cotización. Un agente te responde en breve. 🙏",
        escalateToOwner: true,
        ruleName:        "quote_build_failed",
        tokensUsed:      botResult.tokensUsed,
      };
    }

    const quoteMsg = formatQuoteMessage(quote, {
      property: mergedData.property!,
      checkIn:  mergedData.checkIn!,
      checkOut: mergedData.checkOut!,
      guests:   mergedData.guests!,
    });

    // Si el bot también respondió una pregunta, combinar ambas respuestas
    // (ej: "¿Hay piscina? Somos 4 del 15 al 20 en Villa B11")
    const reply =
      botResult.intent === "asking_question" && quote.available && !quote.exceedsCapacity
        ? `${botResult.reply}\n\n${quoteMsg}`
        : quoteMsg;

    const nextState: ConvState = quote.available ? "quote_provided" : "awaiting_quote_data";
    await upsertState(phone, nextState, mergedData, env.DB);

    return {
      reply,
      escalateToOwner: false,
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
): Promise<QuoteFlowResult> {
  const cardChoice     = isCardChoice(text);
  const transferChoice = isTransferChoice(text);

  if (!cardChoice && !transferChoice) {
    return {
      reply: "Disculpá, ¿podés elegir una opción?\n\n💳 *Tarjeta* (PayPal, link inmediato)\n🏦 *Transferencia* (BAC, te paso los datos)",
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
  );

  if (!quote || !quote.available) {
    await cancelQuoteFlow(phone, env.DB);
    return {
      reply:           "Ups, hubo un problema procesando tu reserva. Un agente te asiste en breve. 🙏",
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
        reply: "Hubo un problema generando el link de PayPal. Te paso los datos de transferencia:\n\n" +
               buildTransferMessageHNL(quote.depositHNL),
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
      reply: `¡Listo! El 50% de depósito es HNL ${quote.depositHNL.toLocaleString("es-HN")} (≈ USD ${quote.depositUSD.toFixed(2)}). Pagás acá:

👉 ${orderResult.approvalUrl}

Al confirmar el pago recibís automáticamente:
✅ Confirmación de reserva por correo
📋 Instrucciones de check-in

El saldo (HNL ${quote.balanceHNL.toLocaleString("es-HN")}) se paga el día de llegada. 🌴`,
      escalateToOwner: false,
      ruleName:        "paypal_link_sent",
      tokensUsed:      0,
    };
  }

  // ── Sub-flow B: Transferencia bancaria ────────────────────────────────────
  await upsertState(phone, "awaiting_transfer_proof", { ...data, depositUsd: quote.depositUSD }, env.DB);
  return {
    reply:           buildTransferMessageHNL(quote.depositHNL),
    escalateToOwner: true,
    ruleName:        "transfer_details_sent",
    tokensUsed:      0,
  };
}

/** Cancela el quote flow para un número (cuando el huésped pide hablar con humano). */
export async function cancelQuoteFlow(phone: string, db: D1Database): Promise<void> {
  await clearState(phone, db);
}
