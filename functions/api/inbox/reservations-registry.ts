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

  const TAIL = `FROM reservations
        WHERE status IN ('confirmed', 'pending')
        ORDER BY check_in DESC, created_at DESC
        LIMIT 500`;
  try {
    // Con las columnas LPS (schema 0030). Si la migración todavía no se aplicó,
    // caemos al SELECT base para que la planilla NO se rompa.
    let rows;
    try {
      rows = await env.DB.prepare(
        `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone,
                guest_count, amount_usd, total_hnl, paid_hnl, source, status, created_at
         ${TAIL}`,
      ).all();
    } catch {
      rows = await env.DB.prepare(
        `SELECT id, property_slug, check_in, check_out, guest_name, guest_phone,
                guest_count, amount_usd, source, status, created_at
         ${TAIL}`,
      ).all();
    }
    return json({ ok: true, reservations: rows.results ?? [] });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};
