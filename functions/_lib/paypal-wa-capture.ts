/// <reference types="@cloudflare/workers-types" />
//
// paypal-wa-capture.ts — Decisión del PAYMENT.CAPTURE.COMPLETED para órdenes
// creadas por el bot de WhatsApp (custom_id "wa:<phone>|<slug>|<in>|<out>|<n>").
//
// Por qué existe (auditoría 2026-07-12, hallazgos A1/A2):
//   A1. La rama waOrigin insertaba la reserva SIN chequear solape: dos leads
//       pagando fechas que chocan (o una reserva de Airbnb ya en D1) = doble
//       booking con plata capturada y cero aviso. La rama del website YA tenía
//       overlap+refund (Auditoría Sesión 2 — B1) y receipt.ts también (paso 6);
//       acá faltaba. Ahora: solape → refund automático + disculpa + alerta.
//       El chequeo va DENTRO del INSERT (WHERE NOT EXISTS): una sola sentencia
//       atómica, sin ventana entre chequear y escribir — dos capturas
//       simultáneas de fechas que chocan no pueden insertarse las dos.
//   A2. Insertaba status='confirmed' con solo el DEPÓSITO (50%) pagado → el cron
//       de check-in (WHERE status='confirmed') mandaba WiFi/códigos con la mitad
//       pagada. La política de la casa (receipt.ts:17-19, website=pago total) es:
//       instrucciones SOLO con pago total. Ahora el depósito crea 'pending' —
//       bloquea fechas igual, entra a la cola "Por verificar" del inbox y a las
//       métricas (leen pending+confirmed); el cron de check-in alerta a dueños
//       si una llegada de mañana sigue 'pending'.
//
// El módulo decide y hace el I/O de D1 + refund; NO manda mensajes ni emails
// (eso lo hace el webhook, igual que el patrón de receipt.ts). Las dos deps con
// side-effects externos (db, refund) van inyectadas → testeable con stub.

import { T, type Lang } from "./i18n";
import type { OwnerAlert } from "./owner-alerts";
import type { PayPalRefundParams, PayPalRefundResult } from "./paypal-refund";
import { overlapSlugs, slugPlaceholders } from "./slug-overlap";

export interface WaCaptureInput {
  phone: string;          // dígitos E.164 sin '+' (formato del custom_id)
  propertySlug: string;
  propertyName: string;   // nombre legible (para los mensajes)
  checkIn: string;        // YYYY-MM-DD
  checkOut: string;       // YYYY-MM-DD
  guests: number;
  orderId: string;
  captureId: string;
  amountUsd: number;
  guestName: string | null;
  guestEmail: string | null;
  rawBody: string;
  accessToken: string;    // token PayPal ya emitido por el webhook (para el refund)
  todayIso: string;       // todayHn() — para detectar llegada same-day
  lang: Lang;
}

export interface WaCaptureDeps {
  db: D1Database;
  refund: (args: PayPalRefundParams) => Promise<PayPalRefundResult>;
}

export interface WaCaptureResult {
  /** 'reserved' es el ÚNICO outcome que creó la fila de la reserva. */
  outcome: "reserved" | "overlap_refunded" | "duplicate" | "insert_failed";
  /** Texto para el huésped por WhatsApp (null = no mandar nada, ej. reintento). */
  guestMessage: string | null;
  /** Alerta a dueños (null = no alertar). Solo overlap, fallo de registro o same-day. */
  ownerAlert: OwnerAlert | null;
  /** Resumen para paypal_webhook_log. */
  logMessage: string;
}

function duplicateResult(orderId: string, status?: string): WaCaptureResult {
  return {
    outcome: "duplicate",
    guestMessage: null,
    ownerAlert: null,
    logMessage: `Reserva ya existía (webhook duplicado): ${orderId}${status ? ` (status ${status})` : ""}`,
  };
}

export async function handleWaCapture(
  deps: WaCaptureDeps,
  input: WaCaptureInput,
): Promise<WaCaptureResult> {
  const { db, refund } = deps;
  const {
    phone, propertySlug, propertyName, checkIn, checkOut, guests,
    orderId, captureId, amountUsd, guestName, guestEmail, rawBody,
    accessToken, todayIso, lang,
  } = input;

  const cliente = `${guestName ?? "(sin nombre)"} +${phone}`;

  // Slugs que comparten inventario físico con el pedido (combo las-gemelas ↔
  // brisa+marea): el chequeo de solape debe mirar TODOS, no solo el slug exacto.
  const blockSlugs = overlapSlugs(propertySlug);

  /** ¿Este orderId ya tiene fila? (reintento de PayPal → ya lo procesamos entero:
   *  NO volver a reembolsar ni a mensajear). Fail-open: si la query falla, el
   *  INSERT OR IGNORE de abajo sigue deduplicando la fila. */
  const findPrior = async (): Promise<{ status: string } | null> => {
    try {
      return await db
        .prepare(`SELECT status FROM reservations WHERE paypal_order_id = ? LIMIT 1`)
        .bind(orderId)
        .first<{ status: string }>();
    } catch {
      return null;
    }
  };

  // 0. Reintento del webhook con fila ya creada (reservada o cancelada-por-overlap).
  const prior0 = await findPrior();
  if (prior0) return duplicateResult(orderId, prior0.status);

  // 1. INSERT del depósito como 'pending', condicionado a NO-solape en la MISMA
  //    sentencia (WHERE NOT EXISTS) — atómico en SQLite: cierra la carrera
  //    chequear→escribir que un SELECT previo dejaría abierta. pending+confirmed
  //    bloquean; las reservas de Airbnb viven en esta misma tabla, así que el
  //    chequeo las cubre. Hasta 2 intentos: si el bloqueador desaparece entre el
  //    insert frenado y la lectura de detalles (lo cancelaron justo en el medio),
  //    se reintenta una vez en lugar de reembolsar por un conflicto que ya no existe.
  for (let attempt = 0; attempt < 2; attempt++) {
    let inserted = 0;
    try {
      const ins = await db
        .prepare(
          `INSERT OR IGNORE INTO reservations
             (property_slug, check_in, check_out, guest_name, guest_email,
              guest_phone, guest_phone_normalized, paypal_order_id,
              amount_usd, source, status, raw_payload, guest_count)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp_bot', 'pending', ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM reservations
               WHERE property_slug IN (${slugPlaceholders(blockSlugs)})
                 AND status IN ('pending', 'confirmed')
                 AND paypal_order_id != ?
                 AND check_in < ?
                 AND check_out > ?
            )`,
        )
        .bind(
          propertySlug, checkIn, checkOut, guestName, guestEmail,
          phone, phone, orderId, amountUsd || null, rawBody, guests,
          ...blockSlugs, orderId, checkOut, checkIn,
        )
        .run();
      inserted = ins.meta?.changes ?? 0;
    } catch (err) {
      // Plata capturada SIN fila de reserva = crítico: no afirmar "reservado" en
      // falso (lección Casa Lara fantasma) — avisar a dueños para terminarla a mano.
      return {
        outcome: "insert_failed",
        guestMessage: T.paypalReceivedRegisterPending(lang),
        ownerAlert: {
          tipo: "🔴 Pago PayPal SIN reserva registrada",
          cliente,
          detalle:
            `${propertyName} ${checkIn}→${checkOut} · USD ${amountUsd || "?"} · orden ${orderId} · ` +
            `D1 falló: ${(err as Error).message.slice(0, 150)} — registrar a mano`,
          guestPhone: phone,
        },
        logMessage: `Pago capturado pero INSERT de reserva FALLÓ: ${(err as Error).message.slice(0, 300)}`,
      };
    }

    if (inserted > 0) {
      // Same-day: llegada HOY con solo el depósito → el flujo automático de
      // check-in ya no aplica (el cron T-1 corrió ayer) → César coordina saldo +
      // ingreso a mano, igual que los comprobantes same-day de receipt.ts.
      const sameDay = checkIn === todayIso;
      return {
        outcome: "reserved",
        guestMessage: T.paypalDepositReceived(lang, { propertyName, checkIn, checkOut, guests }),
        ownerAlert: sameDay
          ? {
              tipo: "Pago PayPal SAME-DAY — coordinar check-in",
              cliente,
              detalle:
                `${propertyName} llega HOY (${checkIn}) · depósito USD ${amountUsd || "?"} pagado · ` +
                `falta saldo 50% + instrucciones de ingreso`,
              guestPhone: phone,
            }
          : null,
        logMessage: `Reserva insertada (pending, depósito): ${propertySlug} ${checkIn}→${checkOut}`,
      };
    }

    // No insertó. ¿Reintento del mismo orderId que ganó una carrera (OR IGNORE)?
    const prior = await findPrior();
    if (prior) return duplicateResult(orderId, prior.status);

    // ¿Solape real? Leer los detalles del bloqueador para el refund y el aviso.
    let overlap: { paypal_order_id: string; check_in: string; check_out: string } | null = null;
    try {
      overlap = await db
        .prepare(
          `SELECT paypal_order_id, check_in, check_out
             FROM reservations
            WHERE property_slug IN (${slugPlaceholders(blockSlugs)})
              AND status IN ('pending', 'confirmed')
              AND paypal_order_id != ?
              AND check_in < ?
              AND check_out > ?
            LIMIT 1`,
        )
        .bind(...blockSlugs, orderId, checkOut, checkIn)
        .first<{ paypal_order_id: string; check_in: string; check_out: string }>();
    } catch {
      overlap = null;
    }
    if (!overlap) continue; // el bloqueador desapareció (o D1 falló) → reintentar el insert

    const refundResult = await refund({
      captureId,
      amountUsd: amountUsd > 0 ? amountUsd : undefined,
      noteToPayer:
        "Refund automático: las fechas fueron tomadas por otro huésped simultáneamente.",
      accessToken,
    });

    // Audit trail como 'cancelled' (no bloquea fechas). UNIQUE(paypal_order_id)
    // dedupea reintentos — y el paso 0 evita re-reembolsar en el reintento.
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO reservations
             (property_slug, check_in, check_out, guest_name, guest_email,
              guest_phone, guest_phone_normalized, paypal_order_id,
              amount_usd, source, status, raw_payload, guest_count, notification_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp_bot', 'cancelled', ?, ?, ?)`,
        )
        .bind(
          propertySlug, checkIn, checkOut, guestName, guestEmail,
          phone, phone, orderId, amountUsd || null, rawBody, guests,
          `OVERLAP con orden ${overlap.paypal_order_id} (${overlap.check_in}→${overlap.check_out}). ` +
            `Refund: ${refundResult.ok ? `OK (${refundResult.refundId ?? "sin id"}, status ${refundResult.status ?? "n/a"})` : `FALLÓ — ${refundResult.error?.slice(0, 400) ?? "error desconocido"}`}`,
        )
        .run();
    } catch {
      /* best-effort: el log del webhook igual registra el overlap */
    }

    return {
      outcome: "overlap_refunded",
      guestMessage: T.paypalOverlapRefunded(lang, propertyName),
      ownerAlert: {
        tipo: refundResult.ok
          ? "Pago PayPal reembolsado (fechas chocaron)"
          : "🔴 REFUND FALLÓ — devolver a mano",
        cliente,
        detalle:
          `${propertyName} ${checkIn}→${checkOut} · USD ${amountUsd || "?"} · ` +
          `choca con ${overlap.paypal_order_id}` +
          (refundResult.ok ? "" : ` · refund error: ${refundResult.error?.slice(0, 120) ?? "?"}`),
        guestPhone: phone,
      },
      logMessage:
        `OVERLAP detectado con orden ${overlap.paypal_order_id}. ` +
        `Refund: ${refundResult.ok ? `OK (${refundResult.refundId ?? "sin id"})` : `FALLÓ — ${refundResult.error?.slice(0, 200)}`}`,
    };
  }

  // 2 intentos sin insertar, sin orderId previo y sin solape identificable
  // (D1 intermitente). El pago quedó capturado sin fila → mismo trato crítico.
  return {
    outcome: "insert_failed",
    guestMessage: T.paypalReceivedRegisterPending(lang),
    ownerAlert: {
      tipo: "🔴 Pago PayPal SIN reserva registrada",
      cliente,
      detalle:
        `${propertyName} ${checkIn}→${checkOut} · USD ${amountUsd || "?"} · orden ${orderId} · ` +
        `el INSERT no aplicó y no se pudo identificar la causa — registrar a mano`,
      guestPhone: phone,
    },
    logMessage: `Pago capturado pero la reserva no se pudo registrar (2 intentos, causa no identificada)`,
  };
}
