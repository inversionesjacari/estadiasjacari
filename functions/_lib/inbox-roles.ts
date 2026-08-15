/// <reference types="@cloudflare/workers-types" />
//
// Redacción de plata para el rol "staff" (2026-08-15, entra Isaías Rivera).
//
// El empleado gestiona conversaciones y operación: necesita saber SI una reserva
// está pagada (para no mandarle a cobrar a quien ya pagó, ni dar por cerrada una
// que no lo está), pero NO cuánto entró. Este módulo es el único lugar donde se
// decide qué monto se borra y qué se deja.
//
// Cómo funciona:
//   1. Se calcula `pay_state` con los montos REALES (paid / deposit / unpaid /
//      verify / cancelled / refunded) — mismo criterio que ya usaban
//      /inbox/registro y /inbox/reservas, para no contradecirse.
//   2. Se ponen en null TODOS los campos de plata.
//   3. El front, cuando ve `pay_state`, dibuja el badge SIN números.
//
// Para el dueño no cambia nada: `redactMoney` con rol "owner" devuelve las filas
// tal cual, sin tocar ni agregar campos.
//
// Los montos nunca salen del Worker para un staff: no es que el front los
// esconda, es que no viajan.
//
// Las filas llegan como salen de D1 (`Record<string, unknown>`), porque cada
// endpoint arma su propio SELECT con fallbacks progresivos y no todas las
// columnas existen siempre.
//

import type { InboxSession } from "./inbox-auth";

/** Campos de plata que NUNCA viajan a un staff. */
export const MONEY_FIELDS = [
  "amount_usd",
  "total_hnl",
  "paid_hnl",
  "tr_amount",
  "tr_expected_hnl",
] as const;

export type PayState = "paid" | "deposit" | "unpaid" | "verify" | "cancelled" | "refunded";

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Estado del pago SIN revelar montos. Réplica del criterio de las dos pantallas:
 * el libro en Lempiras manda; sin libro, PayPal confirmado = pagado de verdad y
 * transferencia/manual = hay que verificar (nunca afirmar "pagado" de gratis).
 */
export function payStateOf(r: Row): PayState {
  const status = str(r.status);
  if (status === "cancelled") return "cancelled";
  if (status === "refunded") return "refunded";

  const total = num(r.total_hnl);
  if (total != null) {
    const paid = num(r.paid_hnl) ?? 0;
    if (paid >= total) return "paid";
    return paid > 0 ? "deposit" : "unpaid";
  }

  const source = str(r.source);
  if (source === "whatsapp_transfer" || source === "manual") {
    return num(r.tr_amount) != null ? "deposit" : "verify";
  }
  if (status === "confirmed") return "paid";
  return "verify";
}

/**
 * Devuelve las filas listas para mandar. Owner: intactas (misma referencia, cero
 * costo). Cualquier otro caso —staff, o una sesión que no llegó porque el
 * endpoint se olvidó de pasarla—: copia sin montos y con `pay_state`.
 *
 * La condición se escribe "solo owner ve los números", NO "staff no los ve": si
 * mañana alguien agrega un endpoint y olvida el `auth.session`, el resultado es
 * que César ve guiones (bug visible que se reporta en el día) en vez de que el
 * empleado vea la plata (fuga silenciosa que nadie nota).
 */
export function redactMoney<T extends Row>(rows: T[], session: InboxSession | undefined): T[] {
  if (session?.role === "owner") return rows;
  return rows.map((row) => {
    const out: Row = { ...row, pay_state: payStateOf(row) };
    // Se ponen en null SIEMPRE, existan o no en la fila: así el front nunca
    // distingue "no vino la columna" de "no te toca verla".
    for (const field of MONEY_FIELDS) out[field] = null;
    return out as T;
  });
}
