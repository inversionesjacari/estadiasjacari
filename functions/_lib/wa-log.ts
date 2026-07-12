/// <reference types="@cloudflare/workers-types" />
//
// wa-log.ts — Registro de envíos por TEMPLATE en `whatsapp_messages`.
//
// Problema que resuelve (auditoría de entrega, 12-jul): los mensajes de PLANTILLA
// (instrucciones de check-in con PDF, confirmaciones de reserva, avisos operativos)
// salían por fetch directo y NO dejaban fila en `whatsapp_messages` → el callback
// de estado de Meta (handleStatusUpdate) no tenía fila que actualizar y su entrega
// era invisible: un check-in que Meta descartaba (ej. billing 131042) moría en
// silencio. Con fila + wamid, los checks sent→delivered→read→failed se actualizan
// GRATIS por el webhook, se ven en el chat del inbox (✓/✓✓/⚠) y alimentan la card
// "📬 Salud de entrega" de /inbox/operacion.
//
// Qué SÍ registra: envíos al HUÉSPED y al STAFF (números que no son leads nuevos:
// la lista de conversaciones del inbox nace SOLO de filas direction='in'
// —conversations.ts— así que estas filas OUT no crean "leads" fantasma).
// Qué NO registra: las alertas a dueños (owner-alerts.ts) — ya tienen su propia
// telemetría (heartbeats owner_alert_ok/fail + bot_trace OWNER_ALERT_FAIL) y sus
// fallos de entrega igual quedan en WA_DELIVERY_FAILED vía el callback.
//
// Hook listo para whatsapp-operations (hoy desactivado en el cron-worker): cuando
// se active, sus senders (sendToGuest / markBatchResult) llaman logOutboundTemplate
// con las reglas tpl_* de abajo y entran solos a la card.
//
// Carpeta `_lib/` (prefijo underscore) NO es ruteable como endpoint.
//

/** Reglas de envíos OPERATIVOS al huésped: si fallan, el watchdog alerta SIEMPRE. */
export const GUEST_OPERATIONAL_RULES = [
  "checkin_reminder", // instrucciones de check-in + PDF (cron T-1 y paypal mismo-día)
  "tpl_checkin_dia_huesped",
  "tpl_checkout_dia_huesped",
  "tpl_confirmacion_whatsapp_capturado",
] as const;

/** Reglas de avisos al staff (limpieza/seguridad): fallo cuenta para la ráfaga, no alerta solo. */
export const STAFF_OPERATIONAL_RULES = [
  "tpl_checkin_dia_limpieza",
  "tpl_checkout_dia_limpieza",
  "tpl_checkin_dia_seguridad",
] as const;

export interface OutboundTemplateLog {
  /** Nuestro número (env.WHATSAPP_PHONE_NUMBER_ID). */
  fromPhone: string;
  /** Destinatario E.164 sin '+'. */
  toPhone: string;
  /** matched_rule con el que se busca/agrupa (ej. "checkin_reminder", "tpl_confirmacion_whatsapp_capturado"). */
  rule: string;
  /** Resumen humano de QUÉ se mandó (el template real vive en Meta), ej. "📋 Instrucciones check-in + PDF — Villa B11 (15 jul)". */
  summary: string;
  /** Reserva asociada si está a mano (liga la fila al expediente). */
  reservationId?: number | null;
  /** ¿Meta aceptó el envío? */
  ok: boolean;
  /** wamid devuelto por Meta (permite que el callback actualice el status). */
  messageId?: string | null;
  /** Error devuelto por Meta si ok=false. */
  error?: string | null;
}

/**
 * Inserta la fila `out` del envío de template. FAIL-SOFT: nunca lanza — un fallo
 * de telemetría jamás debe romper el envío real (regla de la casa desde B8).
 * `INSERT OR IGNORE` porque meta_message_id es UNIQUE: un reintento del webhook
 * de PayPal (mismo wamid) no duplica la fila.
 */
export async function logOutboundTemplate(
  db: D1Database,
  p: OutboundTemplateLog,
): Promise<void> {
  // Los dry-run de whatsapp-dispatch no tocan Meta ni deben tocar la tabla.
  if (p.messageId === "DRY_RUN") return;
  try {
    const body = p.ok
      ? p.summary
      : `[FAILED] ${p.summary}\n\nERROR: ${p.error ?? "desconocido"}`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO whatsapp_messages
           (meta_message_id, reservation_id, direction, from_phone, to_phone, body, matched_rule, escalated, status)
         VALUES (?, ?, 'out', ?, ?, ?, ?, 0, ?)`,
      )
      .bind(
        p.messageId ?? null,
        p.reservationId ?? null,
        p.fromPhone,
        p.toPhone,
        body,
        p.rule,
        p.ok ? "sent" : "failed",
      )
      .run();
  } catch (err) {
    console.error("wa-log: error registrando template saliente:", (err as Error).message);
  }
}
