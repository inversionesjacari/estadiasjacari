/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/reservations-registry
//
// Registro completo de huéspedes/reservas (la planilla tipo Excel de /inbox/registro).
// Lista TODAS las reservas reales —pasadas y futuras— en estado 'confirmed' (pago
// completo) o 'pending' (depósito 50% / por verificar), ordenadas por fecha de llegada
// (las más recientes primero). Usa SOLO columnas que existen seguro en producción (las
// mismas que reservations-pending.ts + guest_count, que receipt.ts ya inserta) para no
// depender de schemas sin aplicar. Protegido con la cookie de sesión del inbox.
//
// ?include=cancelled → además trae las canceladas y reembolsadas (con cancelled_at
// y cancel_reason cuando existen), para la vista "Canceladas" del registro. Por
// defecto NO se incluyen: el registro activo queda idéntico.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";

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

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const includeCancelled = new URL(request.url).searchParams.get("include") === "cancelled";
  const statusList = includeCancelled
    ? "('confirmed', 'pending', 'cancelled', 'refunded')"
    : "('confirmed', 'pending')";
  const TAIL = `FROM reservations
        WHERE status IN ${statusList}
        ORDER BY check_in DESC, created_at DESC
        LIMIT 500`;

  // Columnas del rastro de cancelación (schema 0045). Solo se piden en la vista
  // de canceladas; van en el nivel 1 del fallback para que su ausencia degrade
  // sin tumbar la planilla.
  const cancelCols = includeCancelled ? ", cancelled_at, cancel_reason" : "";
  // Fallback progresivo: 1) LPS + rastro de cancelación, 2) LPS, 3) base. Cada
  // "no such column" baja un nivel para no depender de migraciones sin aplicar.
  const selects = [
    `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone,
            guest_count, amount_usd, total_hnl, paid_hnl, source, status, created_at${cancelCols}
     ${TAIL}`,
    `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone,
            guest_count, amount_usd, total_hnl, paid_hnl, source, status, created_at
     ${TAIL}`,
    `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone,
            guest_count, amount_usd, source, status, created_at
     ${TAIL}`,
  ];

  try {
    for (let i = 0; i < selects.length; i++) {
      try {
        const rows = await env.DB.prepare(selects[i]).all();
        return json({ ok: true, reservations: rows.results ?? [] });
      } catch (err) {
        if (i === selects.length - 1 || !/no such column/i.test((err as Error).message)) throw err;
      }
    }
    return json({ ok: true, reservations: [] });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};
