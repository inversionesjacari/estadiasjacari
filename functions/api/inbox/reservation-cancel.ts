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
// STAFF TAMBIÉN CANCELA (decisión de César, 2026-08-17): cancelar es operación
// del día —el huésped avisa por WhatsApp y las fechas tienen que quedar libres YA
// para re-venderlas—, no una gestión de tesorería. Antes era `requireOwner` y el
// empleado tenía que esperar a César, con las fechas muertas mientras tanto.
// Lo que NO cambia: los MONTOS siguen sin viajarle al staff (redactMoney) — el
// diálogo le dice QUÉ pasa con el pago, nunca CUÁNTO. Y toda cancelación queda
// firmada en `cancelled_by` con el nombre de quien la hizo, para que César vea
// en el registro quién canceló qué.
//
// Protegido con la cookie de sesión del inbox. Body: { id, action?, reason? }.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { findOverlappingReservations, buildOverlapWarning } from "./reservation-create";
import { notifyOwners } from "../../_lib/owner-alerts";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
  // Aviso a los socios (César + Eduardo) cuando una reserva se cancela o revive.
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

const PROPERTY_NAMES: Record<string, string> = {
  "villa-b11-palma-real": "Villa B11 — Palma Real",
  "casa-brisa": "Casa Brisa",
  "casa-marea": "Casa Marea",
  "centro-morazan": "Centro Morazán",
  "casa-lara-townhouse": "Casa Lara Townhouse",
  "la-florida": "La Florida",
  "las-gemelas-tela": "Las Gemelas (Tela)",
};

/** Fila que alimenta el aviso a los socios. */
interface AlertRow {
  property_slug: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  guest_phone: string | null;
  total_hnl: number | null;
  paid_hnl: number | null;
  amount_usd: number | null;
}

/** "19 ago" — fecha corta para que el aviso entre en los 250 chars de Meta. */
const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function shortDate(iso: string): string {
  const [, m, d] = (iso || "").split("-");
  const mi = Number(m) - 1;
  return MONTHS_ES[mi] ? `${Number(d)} ${MONTHS_ES[mi]}` : iso;
}

/**
 * Qué plata está en juego. Va SOLO al WhatsApp de los dueños (OWNER_PHONES), así
 * que acá sí se nombran montos: es la información que le permite a César decidir
 * si perseguir la cancelación. Pura y exportada para el test.
 */
export function moneyLine(r: AlertRow): string {
  const paid = r.paid_hnl ?? 0;
  if (r.total_hnl != null && paid > 0) {
    return `pagó L ${Math.round(paid).toLocaleString("es-HN")} (los pierde)`;
  }
  if (r.total_hnl != null) return "sin pago recibido";
  if (r.amount_usd != null && r.amount_usd > 0) {
    return `pagó $${r.amount_usd} (los pierde)`;
  }
  return "sin pago cargado";
}

/**
 * Texto del aviso a los socios. Pura y exportada para el test — el detalle tiene
 * que entrar en los 250 caracteres que acepta el parámetro de Meta.
 */
export function buildCancelAlert(
  r: AlertRow,
  actor: string | null,
  reason: string,
  action: "cancel" | "restore",
) {
  const prop = PROPERTY_NAMES[r.property_slug] ?? r.property_slug;
  const fechas = `${shortDate(r.check_in)} → ${shortDate(r.check_out)}`;
  const quien = actor || "alguien del inbox";
  const detalle =
    action === "cancel"
      ? `${prop} · ${fechas} · canceló ${quien} · ${moneyLine(r)}${reason ? ` · motivo: ${reason}` : ""} · fechas LIBRES para re-vender`
      : `${prop} · ${fechas} · la reactivó ${quien} · las fechas vuelven a quedar BLOQUEADAS`;
  return {
    tipo: action === "cancel" ? "Reserva CANCELADA" : "Reserva REACTIVADA",
    cliente: `${r.guest_name || "Huésped sin nombre"} ${r.guest_phone || ""}`.trim(),
    detalle: detalle.slice(0, 250),
    guestPhone: (r.guest_phone || "").replace(/\D/g, ""),
  };
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

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;
  // Quién cancela ("Propietario" / "Isaías Rivera") — firma de la cancelación.
  const actor = auth.session?.user ?? null;

  /**
   * Aviso por WhatsApp a los socios (César + Eduardo) — pedido de César el
   * 2026-08-17, al abrirle el botón al empleado: una cancelación mueve plata y
   * libera fechas, los dos socios tienen que enterarse en el momento, no
   * descubrirlo después en el registro.
   *
   * Va en `waitUntil`: se dispara DESPUÉS de responderle al inbox, así el botón
   * no se queda girando esperando a Meta. Best-effort de punta a punta —
   * notifyOwners nunca lanza y deja su propio rastro (heartbeat + bot_trace) si
   * el envío falla, así que un canal caído no se traga en silencio.
   */
  const alertOwners = (id: number, action: "cancel" | "restore", reason: string): void => {
    const task = (async () => {
      try {
        const row = await env.DB.prepare(
          `SELECT property_slug, check_in, check_out, guest_name, guest_phone,
                  total_hnl, paid_hnl, amount_usd
             FROM reservations WHERE id = ?`,
        ).bind(id).first<AlertRow>();
        if (!row) return;
        await notifyOwners(
          {
            WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
            WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
            DB: env.DB,
          },
          buildCancelAlert(row, actor, reason, action),
        );
      } catch {
        /* el aviso nunca puede tumbar la cancelación */
      }
    })();
    try {
      context.waitUntil(task);
    } catch {
      /* sin waitUntil (tests/entorno raro): queda como promesa suelta best-effort */
      void task;
    }
  };

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

    // Reactivar es DESHACER lo que uno mismo canceló. Una fila SIN
    // `cancel_prev_status` no la canceló una persona desde el inbox: la canceló
    // el SISTEMA —PayPal rechazó el cobro (PAYMENT.CAPTURE.DENIED) o el huésped
    // canceló por Airbnb— y ahí no hay estado que restaurar, se adivina con
    // `deriveRestoreStatus`, que para website/airbnb devuelve 'confirmed'. O
    // sea: revivirla la marcaría PAGADA y le dispararía las instrucciones de
    // check-in a alguien cuyo pago fue DENEGADO. Esa decisión es de dueño
    // (reservation-confirm.ts la protege igual), así que el staff se frena acá
    // con un mensaje que le dice qué hacer.
    if (!isRestorableStatus(row.cancel_prev_status) && auth.session?.role !== "owner") {
      return json({
        ok: false,
        code: "forbidden_role",
        error: "Esta reserva la canceló el sistema (Airbnb o un pago rechazado), no una persona. Solo César puede reactivarla — avisale.",
      }, 403);
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
      const res = await tryUpdate(env.DB, buildRestoreVariants(status, id));
      if ((res.meta?.changes ?? 0) === 0) {
        return json({ ok: false, error: "La reserva ya no estaba cancelada." }, 409);
      }
      alertOwners(id, "restore", "");
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
    const res = await tryUpdate(env.DB, buildCancelVariants(reason || null, actor, id));

    if ((res.meta?.changes ?? 0) === 0) {
      // O no existe, o ya estaba cancelada/reembolsada.
      const cur = await env.DB.prepare(`SELECT status FROM reservations WHERE id = ?`).bind(id).first<{ status: string }>();
      if (!cur) return json({ ok: false, error: "No se encontró esa reserva." }, 404);
      return json({ ok: false, error: `La reserva ya está "${cur.status}", no se puede cancelar.` }, 409);
    }
    alertOwners(id, "cancel", reason);
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

export interface UpdateVariant {
  sql: string;
  binds: unknown[];
}

/**
 * Las 3 variantes del CANCELAR, de más a menos columnas. Exportadas para que el
 * test verifique el SQL REAL (una copia a mano en el test no prueba nada: el
 * contrato que importa es "tantos binds como '?'", y ese conteo cambia por nivel).
 */
export function buildCancelVariants(reason: string | null, actor: string | null, id: number): UpdateVariant[] {
  return [
    { sql: `UPDATE reservations SET status = 'cancelled', cancel_prev_status = status, cancelled_at = datetime('now'), cancel_reason = ?, cancelled_by = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('pending','confirmed')`, binds: [reason, actor, id] },
    { sql: `UPDATE reservations SET status = 'cancelled', cancel_prev_status = status, cancelled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('pending','confirmed')`, binds: [reason, id] },
    { sql: `UPDATE reservations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status IN ('pending','confirmed')`, binds: [id] },
  ];
}

/** Las 3 variantes del REACTIVAR (limpian el rastro de la cancelación). */
export function buildRestoreVariants(status: string, id: number): UpdateVariant[] {
  return [
    { sql: `UPDATE reservations SET status = ?, cancelled_at = NULL, cancel_reason = NULL, cancel_prev_status = NULL, cancelled_by = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'cancelled'`, binds: [status, id] },
    { sql: `UPDATE reservations SET status = ?, cancelled_at = NULL, cancel_reason = NULL, cancel_prev_status = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'cancelled'`, binds: [status, id] },
    { sql: `UPDATE reservations SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'cancelled'`, binds: [status, id] },
  ];
}

/**
 * Corre la primera variante; ante "no such column" baja al siguiente nivel, que
 * pide menos columnas. Cubre la ventana real entre desplegar el código y aplicar
 * los ALTER en la D1 remota (el push despliega en minutos; los ALTER los pega
 * César a mano, y `cancelled_by` llegó una semana después que las otras tres).
 * Así CANCELAR siempre funciona y libera las fechas aunque falte el rastro. Cada
 * variante lleva sus propios binds (los niveles bajos no bindean
 * `reason`/`cancelled_by`), y el conteo de '?' cambia entre niveles.
 */
export async function tryUpdate(db: D1Database, variants: UpdateVariant[]): Promise<D1Result> {
  for (let i = 0; i < variants.length; i++) {
    try {
      return await db.prepare(variants[i].sql).bind(...variants[i].binds).run();
    } catch (err) {
      if (i === variants.length - 1 || !/no such column/i.test((err as Error).message)) throw err;
    }
  }
  throw new Error("tryUpdate: sin variantes"); // inalcanzable (el loop siempre sale)
}
