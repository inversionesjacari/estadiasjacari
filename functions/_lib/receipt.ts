/// <reference types="@cloudflare/workers-types" />
//
// receipt.ts — Verificación automática de comprobantes de transferencia.
//
// Cuando un huésped en el paso `awaiting_transfer_proof` manda una FOTO, el bot:
//   1. la lee con visión (GPT-4o-mini) y extrae monto / cuenta / fecha / referencia;
//   2. la chequea contra la reserva esperada (monto ≥ lo que toca, cuenta = la nuestra,
//      fecha reciente, referencia presente y NO reusada);
//   3. decide: todo en verde → auto-confirma (crea la reserva = bloquea el calendario)
//      y le avisa al cliente; algo dudoso o same-day → escala a César para que lo vea.
//
// Decisión de César (2026-06-11): "auto si pasa los chequeos". Para minimizar fraude
// sin un humano: chequeos duros + anti-reuso de la referencia + cualquier duda escala.
// La verificación 100% a prueba de fraude (conciliar contra el depósito REAL de BAC)
// es la Fase 2 (parser de correos del banco), pendiente.
//
// La info de check-in NO se manda acá: la reserva de depósito se crea como 'pending'
// (bloquea fechas pero el cron de check-in solo procesa 'confirmed') → el check-in
// queda gateado al pago TOTAL, como pidió César.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { callOpenAIVisionJson } from "./openai";
import { downloadMedia } from "./whatsapp";
import { BANK_HNL } from "./bank-transfer";
import { buildQuote } from "./quote-builder";
import { buildPricingMap } from "./kb-store";
import { clearState, type ConversationStateRow } from "./quote-state";
import { T, asLang } from "./i18n";
import { todayHn } from "./dates";

export interface ReceiptEnv {
  DB: D1Database;
  OPENAI_API_KEY?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

/** Lo que la visión extrae del comprobante. Todo nullable: si no se lee, va null. */
export interface ReceiptExtraction {
  isReceipt: boolean;          // ¿parece un comprobante de transferencia bancaria?
  amount: number | null;       // monto numérico (sin símbolo de moneda)
  currency: string | null;     // "HNL" | "USD" | null
  recipientName: string | null;
  recipientAccount: string | null;
  bank: string | null;
  date: string | null;         // YYYY-MM-DD si se puede normalizar
  reference: string | null;    // # de referencia / confirmación / transacción
  confidence: "high" | "medium" | "low";
}

export interface ReceiptResult {
  replyText: string;   // lo que el webhook le manda al cliente
  escalate: boolean;   // si true: el webhook marca escalado + pausa el bot
  ruleName: string;    // para el log del inbox
  summary: string;     // para console.log / auditoría
  tokensUsed: number;
}

const VISION_SYSTEM = `Sos un extractor de datos de comprobantes de transferencia bancaria de Honduras (bancos como BAC, Ficohsa, Banpaís, Atlántida, etc.). Te paso la imagen que mandó un cliente. Devolvé SOLO un JSON con estos campos exactos:
{
  "isReceipt": boolean,           // true solo si la imagen es realmente un comprobante/recibo de una transferencia o depósito bancario
  "amount": number | null,        // el MONTO transferido, solo el número (ej. 1250.00 → 1250). null si no se ve claro
  "currency": "HNL" | "USD" | null,// "HNL" para Lempiras (L, Lps, HNL), "USD" para dólares ($). null si no se distingue
  "recipientName": string | null, // nombre del titular/beneficiario que RECIBE (no el que envía). null si no se ve
  "recipientAccount": string | null,// número de cuenta destino (solo dígitos). null si no se ve
  "bank": string | null,          // banco (ej. "BAC"). null si no se ve
  "date": string | null,          // fecha de la transacción en formato YYYY-MM-DD. null si no se puede normalizar
  "reference": string | null,     // número de referencia / confirmación / transacción / comprobante. null si no se ve
  "confidence": "high" | "medium" | "low" // qué tan seguro estás de lo extraído (low si está borroso, cortado, o no parece un comprobante real)
}
Reglas: NO inventes. Si un dato no se ve con claridad, ponelo en null. Si la imagen NO es un comprobante bancario (es una foto de la casa, un sticker, una selfie, etc.), poné isReceipt=false y confidence="low". Respondé SOLO el JSON, sin texto extra.`;

/** Lee un comprobante con visión. Fail-soft. */
export async function readReceipt(
  base64: string,
  mime: string,
  env: ReceiptEnv,
): Promise<{ ok: boolean; data?: ReceiptExtraction; error?: string; tokensUsed: number }> {
  const res = await callOpenAIVisionJson<ReceiptExtraction>(
    VISION_SYSTEM,
    "Extraé los datos de este comprobante de transferencia. Devolvé solo el JSON.",
    base64,
    mime,
    env,
    { maxTokens: 400 },
  );
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error ?? "sin datos", tokensUsed: res.tokensUsed };
  }
  return { ok: true, data: res.data, tokensUsed: res.tokensUsed };
}

/** Normaliza para comparar nombres/cuentas (minúsculas, sin acentos ni espacios/símbolos). */
function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

/** ¿La fecha del comprobante (YYYY-MM-DD) está dentro de los últimos `days` días respecto a hoy HN? */
function isRecentDate(dateIso: string | null, todayIso: string, days = 2): boolean {
  if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return false;
  const d = new Date(dateIso + "T00:00:00Z").getTime();
  const today = new Date(todayIso + "T00:00:00Z").getTime();
  const diffDays = Math.round((today - d) / (1000 * 60 * 60 * 24));
  return diffDays >= -1 && diffDays <= days; // permite hoy, ayer/anteayer, y +1 por timezone
}

/**
 * Procesa el comprobante de transferencia de un huésped que está en
 * `awaiting_transfer_proof`. Hace TODO el trabajo de verificación + decisión y, si
 * corresponde, crea la reserva (bloquea el calendario). Devuelve el texto a responder
 * y si hay que escalar. NO envía mensajes (eso lo hace el webhook).
 */
export async function processTransferReceipt(args: {
  phone: string;
  mediaId: string;
  mediaMime: string | null;
  state: ConversationStateRow;
  guestName: string | null;
  env: ReceiptEnv;
}): Promise<ReceiptResult> {
  const { phone, mediaId, mediaMime, state, guestName, env } = args;
  const lang = asLang(state.data.language);
  const today = todayHn();

  const escalateReview = (summary: string, dup = false): ReceiptResult => ({
    replyText: dup ? T.transferReceiptDuplicate(lang) : T.transferReceiptReview(lang),
    escalate: true,
    ruleName: dup ? "transfer_duplicate" : "transfer_review",
    summary,
    tokensUsed: 0,
  });

  // 0. Datos de la reserva en curso. Sin esto no podemos verificar montos.
  const { property, checkIn, checkOut, guests } = state.data;
  if (!property || !checkIn || !checkOut || typeof guests !== "number") {
    return escalateReview("Comprobante sin datos completos de reserva en el estado");
  }

  // 1. Bajar la imagen.
  const dl = await downloadMedia(mediaId, env);
  if (!dl.ok || !dl.base64) {
    return escalateReview(`No se pudo bajar la imagen: ${dl.error ?? "?"}`);
  }

  // 2. Leerla con visión.
  const read = await readReceipt(dl.base64, dl.mime ?? mediaMime ?? "image/jpeg", env);
  if (!read.ok || !read.data) {
    return escalateReview(`Visión falló: ${read.error ?? "?"}`);
  }
  const r = read.data;
  if (!r.isReceipt || r.confidence === "low") {
    return { ...escalateReview(`No parece comprobante claro (isReceipt=${r.isReceipt}, conf=${r.confidence})`), tokensUsed: read.tokensUsed };
  }

  // 3. Calcular lo esperado. Same-day → total; a futuro → 50%.
  const pricingMap = await buildPricingMap(env.DB);
  const quote = await buildQuote({ property, checkIn, checkOut, guests }, env.DB, pricingMap);
  if (!quote) {
    return { ...escalateReview(`No se pudo cotizar ${property} ${checkIn}→${checkOut}`), tokensUsed: read.tokensUsed };
  }
  const sameDay = checkIn === today;
  const expectedHnl = sameDay ? quote.totalHNL : quote.depositHNL;

  // Same-day: requiere pago TOTAL + entrega de check-in el mismo día → lo maneja
  // César a mano por ahora (v1). Escalamos con los datos ya leídos.
  if (sameDay) {
    await logReceipt(env, { phone, r, property, checkIn, checkOut, expectedHnl, decision: "escalated", reason: "same-day (requiere total + check-in manual)", reservationId: null });
    return { ...escalateReview(`Same-day: pagó ${r.amount} ${r.currency}, total esperado ${quote.totalHNL} HNL`), tokensUsed: read.tokensUsed };
  }

  // 4. Anti-reuso: ¿ya recibimos esta referencia antes?
  if (r.reference) {
    try {
      const dup = await env.DB.prepare(`SELECT id FROM transfer_receipts WHERE reference = ? LIMIT 1`).bind(r.reference).first();
      if (dup) {
        return { ...escalateReview(`Referencia ${r.reference} ya usada antes`, true), tokensUsed: read.tokensUsed };
      }
    } catch { /* si la tabla aún no existe, seguimos (mejor verificar que romper) */ }
  }

  // 5. Chequeos duros. Cualquier fallo → escala a revisión humana.
  const fails: string[] = [];
  if (r.currency && r.currency !== "HNL") fails.push(`moneda ${r.currency} (esperado HNL)`);
  if (typeof r.amount !== "number" || r.amount < expectedHnl) fails.push(`monto ${r.amount} < esperado ${expectedHnl}`);
  const accountOk = norm(r.recipientAccount).includes(norm(BANK_HNL.accountNumber)) && norm(r.recipientAccount).length > 0;
  const nameOk = norm(r.recipientName).includes("jacari");
  if (!accountOk && !nameOk) fails.push(`destino no coincide (cuenta="${r.recipientAccount}", titular="${r.recipientName}")`);
  if (!isRecentDate(r.date, today)) fails.push(`fecha no reciente o ilegible ("${r.date}")`);
  if (!r.reference) fails.push("sin # de referencia");

  if (fails.length > 0) {
    // Rescatar los datos del huésped SIN habilitar abuso del calendario: creamos la
    // reserva 'pending' (que bloquea fechas) SOLO si el comprobante apunta plausiblemente
    // a NUESTRA cuenta (cuenta o titular = jacari). Así rescatamos al huésped real cuya
    // visión leyó mal el monto/fecha, pero una imagen con destino ajeno NO bloquea
    // inventario — solo escala. Y solo cerramos el funnel si DE VERDAD se creó la reserva.
    let reservationId: number | null = null;
    if (accountOk || nameOk) {
      try {
        const overlap = await env.DB.prepare(
          `SELECT id FROM reservations WHERE property_slug = ? AND status IN ('pending','confirmed') AND check_in < ? AND check_out > ? LIMIT 1`,
        ).bind(property, checkOut, checkIn).first();
        if (!overlap) {
          reservationId = await createTransferReservation({
            env, property, checkIn, checkOut, guestName, phone, status: "pending",
            amountUsd: quote.depositUSD, guests, raw: r,
            orderId: `transfer:${r.reference ?? `${phone}:${checkIn}`}`,
          });
          if (reservationId) { try { await clearState(phone, env.DB); } catch { /* best-effort */ } }
        }
      } catch { /* best-effort: si algo falla, igual escalamos con los datos abajo */ }
    }
    await logReceipt(env, { phone, r, property, checkIn, checkOut, expectedHnl, decision: reservationId ? "pending_review" : "escalated", reason: fails.join("; "), reservationId });
    return { ...escalateReview(`Chequeos fallaron${reservationId ? ` → reserva PENDIENTE #${reservationId} (por verificar)` : ""}: ${fails.join("; ")}`), tokensUsed: read.tokensUsed };
  }

  // 6. Anti doble-reserva: ¿se ocuparon las fechas mientras tanto?
  try {
    const overlap = await env.DB.prepare(
      `SELECT id FROM reservations WHERE property_slug = ? AND status IN ('pending','confirmed') AND check_in < ? AND check_out > ? LIMIT 1`,
    ).bind(property, checkOut, checkIn).first();
    if (overlap) {
      await logReceipt(env, { phone, r, property, checkIn, checkOut, expectedHnl, decision: "escalated", reason: "overlap: fechas ocupadas", reservationId: null });
      return { ...escalateReview(`Overlap: ${property} ${checkIn}→${checkOut} ya tomado`), tokensUsed: read.tokensUsed };
    }
  } catch { /* fail-open: si la query falla, seguimos */ }

  // 7. ¡Todo en verde! Crear la reserva (bloquea el calendario) y confirmar.
  const paidFull = typeof r.amount === "number" && r.amount >= quote.totalHNL - 1;
  const status = paidFull ? "confirmed" : "pending";
  const amountUsd = paidFull ? quote.totalUSD : quote.depositUSD;
  const orderId = `transfer:${r.reference ?? `${phone}:${checkIn}`}`;
  let reservationId: number | null = null;

  try {
    reservationId = await createTransferReservation({
      env, property, checkIn, checkOut, guestName, phone, status, amountUsd, guests, raw: r, orderId,
    });
  } catch (err) {
    // Si la reserva no se pudo crear, NO confirmemos en falso → escalar.
    await logReceipt(env, { phone, r, property, checkIn, checkOut, expectedHnl, decision: "escalated", reason: `INSERT reserva falló: ${(err as Error).message}`, reservationId: null });
    return { ...escalateReview(`No se pudo crear la reserva: ${(err as Error).message}`), tokensUsed: read.tokensUsed };
  }

  if (!reservationId) {
    // INSERT OR IGNORE ignorado: el orderId (referencia) ya se procesó → reenvío del
    // mismo comprobante. NO re-confirmar ni duplicar; tratar como ya recibido.
    await logReceipt(env, { phone, r, property, checkIn, checkOut, expectedHnl, decision: "escalated", reason: `comprobante ya procesado (orderId ${orderId})`, reservationId: null });
    return { ...escalateReview(`Comprobante ya procesado antes (ref ${r.reference})`, true), tokensUsed: read.tokensUsed };
  }

  await logReceipt(env, { phone, r, property, checkIn, checkOut, expectedHnl, decision: "auto_confirmed", reason: paidFull ? "pago total" : "depósito", reservationId });

  // Cerrar el funnel: ya quedó la reserva.
  try { await clearState(phone, env.DB); } catch { /* best-effort */ }

  return {
    replyText: paidFull ? T.transferFullConfirmed(lang) : T.transferDatesConfirmed(lang),
    escalate: false,
    ruleName: paidFull ? "transfer_confirmed_full" : "transfer_confirmed_deposit",
    summary: `AUTO-CONFIRMADO ${property} ${checkIn}→${checkOut} · ${r.amount} ${r.currency} · ref ${r.reference} · status ${status} · reserva ${reservationId}`,
    tokensUsed: read.tokensUsed,
  };
}

/** Crea la reserva de una transferencia (source 'whatsapp_transfer'). Devuelve id o null. */
async function createTransferReservation(args: {
  env: ReceiptEnv; property: string; checkIn: string; checkOut: string;
  guestName: string | null; phone: string; status: string; amountUsd: number | null;
  guests: number; raw: unknown; orderId: string;
}): Promise<number | null> {
  const ins = await args.env.DB.prepare(
    `INSERT OR IGNORE INTO reservations
       (property_slug, check_in, check_out, guest_name, guest_email, guest_phone,
        guest_phone_normalized, paypal_order_id, amount_usd, source, status, raw_payload, guest_count)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'whatsapp_transfer', ?, ?, ?)`,
  ).bind(
    args.property, args.checkIn, args.checkOut, args.guestName, args.phone, args.phone,
    args.orderId, args.amountUsd || null, args.status, JSON.stringify(args.raw), args.guests,
  ).run();
  // INSERT OR IGNORE: si paypal_order_id (UNIQUE) ya existía, changes=0 y last_row_id
  // NO es confiable (arrastra el rowid de otro insert). Solo hubo creación si changes>0.
  if ((ins.meta?.changes ?? 0) === 0) return null;
  const id = ins.meta?.last_row_id;
  return typeof id === "number" && id > 0 ? id : null;
}

/** Guarda el comprobante en transfer_receipts (auditoría + anti-reuso). Best-effort. */
async function logReceipt(
  env: ReceiptEnv,
  d: {
    phone: string; r: ReceiptExtraction; property: string; checkIn: string; checkOut: string;
    expectedHnl: number; decision: string; reason: string; reservationId: number | null;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO transfer_receipts
         (phone, reference, amount, currency, bank, account_extracted, name_extracted,
          receipt_date, property_slug, check_in, check_out, expected_hnl, decision,
          decision_reason, reservation_id, raw_extraction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      d.phone, d.r.reference, d.r.amount, d.r.currency, d.r.bank, d.r.recipientAccount,
      d.r.recipientName, d.r.date, d.property, d.checkIn, d.checkOut, d.expectedHnl,
      d.decision, d.reason.slice(0, 500), d.reservationId, JSON.stringify(d.r),
    ).run();
  } catch (err) {
    console.error("logReceipt error:", (err as Error).message);
  }
}
