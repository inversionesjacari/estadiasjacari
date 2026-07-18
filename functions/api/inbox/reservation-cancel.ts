/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/reservation-cancel
//
// Cancela (o reactiva) una reserva a mano desde el registro/dashboard.
//
// Caso de negocio (César, 2026-07-17): el huésped cancela y PIERDE lo que pagó
// (no se reembolsa), pero hay que LIBERAR las fechas para volver a rentarlas.
//
// Cómo funciona: solo cambia `status`. NO llama a PayPal — la plata cobrada se
// queda tal cual (la contabilidad reconcilia contra PayPal/banco real, no contra
// este status). Al pasar a 'cancelled' las fechas se liberan solas: availability,
// la detección de solape y todos los crons de avisos actúan únicamente sobre
// status IN ('pending','confirmed'). La reserva sale del calendario, deja de
// recibir mensajes y desaparece del dashboard y del registro activo.
//
//   action:'cancel'  (default) → pending/confirmed → cancelled  (+ cancelled_at, cancel_reason)
//   action:'restore'           → cancelled → pending/confirmed  (undo de un mal clic)
//
// La reactivación VUELVE A BLOQUEAR las fechas, así que primero verifica que no
// se hayan tomado mientras tanto: si ahora hay solape, se niega y avisa (evita
// re-crear el doble booking que todo el sistema cuida). Reusa exactamente la
// misma detección que la alta manual.
//
// Protegido con la cookie de sesión del inbox. Body: { id, action?, reason? }.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { findOverlappingReservations, buildOverlapWarning } from "./reservation-create";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Fuentes que se guardan nativamente como 'confirmed' al capturarse (pago TOTAL
 * por PayPal/OTA). OJO: 'whatsapp_bot' NO está — el bot solo cobra el DEPÓSITO
 * (50%) y entra como 'pending'; tratarlo como pagado liberaría las instrucciones
 * sin cobrar el saldo. Su pago total, si llega, se reconcilia con total_hnl
 * (rama 1 de deriveRestoreStatus).
 */
const PAID_ON_CAPTURE = new Set(["website", "airbnb", "airbnb_ical"]);

export interface RestoreRow {
  source: string;
  total_hnl: number | null;
  paid_hnl: number | null;
  amount_usd: number | null;
}

/**
 * Estado al que vuelve una reserva reactivada — SOLO como fallback para filas
 * canceladas antes de que existiera `cancel_prev_status` (schema 0045). El
 * camino normal preserva el estado EXACTO previo a la cancelación; el monto por
 * sí solo no distingue un depósito del bot (pending) de una captura total
 * (confirmed) cuando total_hnl es null. Mismo criterio que paymentInfo:
 *   - Libro en Lempiras (total_hnl): confirmed solo si paid_hnl >= total_hnl.
 *   - Fuente confirmada-al-capturar (website/airbnb/airbnb_ical): confirmed.
 *   - Resto (whatsapp_bot depósito, transferencia, manual): pending.
 * Pura y exportada para el test.
 */
export function deriveRestoreStatus(r: RestoreRow): "confirmed" | "pending" {
  if (r.total_hnl != null) {
    return (r.paid_hnl ?? 0) >= r.total_hnl ? "confirmed" : "pending";
  }
  if (PAID_ON_CAPTURE.has(r.source)) {
    return "confirmed";
  }
  return "pending";
}

/** Estado válido para reactivar directo (el guardado antes de cancelar). */
function isRestorableStatus(s: unknown): s is "confirmed" | "pending" {
  return s === "confirmed" || s === "pending";
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "Reserva inválida." }, 400);

  const action = body.action === "restore" ? "restore" : "cancel";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  // ── Reactivar (undo) ────────────────────────────────────────────────────────
  if (action === "restore") {
    let row;
    try {
      row = await selectRestoreRow(env.DB, id);
    } catch (err) {
      return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
    }
    if (!row) return json({ ok: false, error: "No se encontró esa reserva." }, 404);
    if (row.status !== "cancelled") {
      return json({ ok: false, error: "Solo se puede reactivar una reserva cancelada." }, 409);
    }

    // ¿Se tomaron las fechas mientras estuvo cancelada? Si hay solape, NO reactivar
    // (re-crearíamos el doble booking). La query excluye a esta misma reserva
    // porque sigue en 'cancelled' (findOverlapping mira solo pending/confirmed).
    // strict:true → si D1 falla, se ABORTA (no se asume "sin solape"): este gate
    // es la ÚNICA barrera anti-doble-booking, no puede fallar abierto.
    let overlaps;
    try {
      overlaps = await findOverlappingReservations(env.DB, row.property_slug, row.check_in, row.check_out, { strict: true });
    } catch {
      return json({ ok: false, error: "No se pudo verificar si las fechas siguen libres. Reintentá en un momento." }, 503);
    }
    if (overlaps.length > 0) {
      const warning = buildOverlapWarning(row.property_slug, overlaps);
      return json({
        ok: false, blocked: true,
        error: `No se reactivó: esas fechas se ocuparon mientras estaba cancelada. ${warning ?? ""}`.trim(),
      }, 409);
    }

    // Estado EXACTO previo a la cancelación (cancel_prev_status). Solo si falta
    // (fila cancelada antes de 0045) se cae a la heurística de monto.
    const status = isRestorableStatus(row.cancel_prev_status)
      ? row.cancel_prev_status
      : deriveRestoreStatus(row);
    try {
      // Limpia el rastro de cancelación (fail-soft si las columnas no existen aún).
      const res = await tryUpdate(env.DB, [
        `UPDATE reservations SET status = ?, cancelled_at = NULL, cancel_reason = NULL, cancel_prev_status = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'cancelled'`,
        `UPDATE reservations SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'cancelled'`,
      ], [status, id]);
      if ((res.meta?.changes ?? 0) === 0) {
        return json({ ok: false, error: "La reserva ya no estaba cancelada." }, 409);
      }
      return json({ ok: true, action: "restore", id, status });
    } catch (err) {
      return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
    }
  }

  // ── Cancelar ─────────────────────────────────────────────────────────────────
  // Solo desde pending/confirmed (no re-cancelar ni tocar refunded). El status
  // 'cancelled' libera las fechas por sí solo. La plata NO se reembolsa.
  try {
    // `cancel_prev_status = status`: SQLite evalúa el RHS del SET con el valor
    // PREVIO de la fila → guarda 'pending'/'confirmed' para que reactivar vuelva
    // al estado exacto (sin adivinar por monto).
    const res = await tryUpdate(env.DB, [
      `UPDATE reservations SET status = 'cancelled', cancel_prev_status = status, cancelled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('pending','confirmed')`,
      `UPDATE reservations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status IN ('pending','confirmed')`,
    ], [reason || null, id], [id]);

    if ((res.meta?.changes ?? 0) === 0) {
      // O no existe, o ya estaba cancelada/reembolsada.
      const cur = await env.DB.prepare(`SELECT status FROM reservations WHERE id = ?`).bind(id).first<{ status: string }>();
      if (!cur) return json({ ok: false, error: "No se encontró esa reserva." }, 404);
      return json({ ok: false, error: `La reserva ya está "${cur.status}", no se puede cancelar.` }, 409);
    }
    return json({ ok: true, action: "cancel", id, status: "cancelled" });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};

interface RestoreDbRow extends RestoreRow {
  property_slug: string;
  check_in: string;
  check_out: string;
  status: string;
  cancel_prev_status: string | null;
}

/**
 * Lee la fila para reactivar. Pide `cancel_prev_status` (schema 0045); si la
 * columna aún no existe, reintenta sin ella (queda null → cae a la heurística).
 * Otros errores de D1 se propagan (el llamador responde 500).
 */
async function selectRestoreRow(db: D1Database, id: number): Promise<RestoreDbRow | null> {
  const base = `property_slug, check_in, check_out, source, total_hnl, paid_hnl, amount_usd, status`;
  try {
    return await db
      .prepare(`SELECT ${base}, cancel_prev_status FROM reservations WHERE id = ?`)
      .bind(id)
      .first<RestoreDbRow>();
  } catch (err) {
    if (!/no such column/i.test((err as Error).message)) throw err;
    const row = await db
      .prepare(`SELECT ${base} FROM reservations WHERE id = ?`)
      .bind(id)
      .first<Omit<RestoreDbRow, "cancel_prev_status">>();
    return row ? { ...row, cancel_prev_status: null } : null;
  }
}

/**
 * Corre el primer UPDATE; si falla por columna faltante (migración 0045 sin
 * aplicar), reintenta con el fallback (sin las columnas de auditoría) — así
 * CANCELAR siempre funciona y libera las fechas aunque falte el rastro. Cada
 * variante puede tener su propio set de binds (el fallback no bindea `reason`).
 */
async function tryUpdate(
  db: D1Database,
  sqls: string[],
  bindsFull: unknown[],
  bindsFallback: unknown[] = bindsFull,
): Promise<D1Result> {
  try {
    return await db.prepare(sqls[0]).bind(...bindsFull).run();
  } catch (err) {
    if (/no such column/i.test((err as Error).message) && sqls[1]) {
      return await db.prepare(sqls[1]).bind(...bindsFallback).run();
    }
    throw err;
  }
}
