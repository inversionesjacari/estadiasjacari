/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/reservation-payment
//
// Actualiza el pago (en Lempiras) de una reserva existente: total y pagado.
// Sirve para corregir/cargar el pago de una reserva que ya está en el registro
// (ej. la que el bot creó con depósito). Recalcula el estado: pagado completo
// → confirmed; falta saldo → pending. Protegido con la cookie del inbox.
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

  const totalNum = Number(body.total_hnl);
  const total_hnl = Number.isFinite(totalNum) && totalNum > 0 ? totalNum : null;
  const paidNum = Number(body.paid_hnl);
  const paid_hnl = Number.isFinite(paidNum) && paidNum >= 0 ? paidNum : 0;
  if (total_hnl !== null && paid_hnl > total_hnl) {
    return json({ ok: false, error: "El pagado no puede ser mayor al total." }, 400);
  }
  if (paid_hnl > 0 && total_hnl === null) {
    return json({ ok: false, error: "Poné el total para registrar el pago." }, 400);
  }
  // Estado derivado del pago: pagado completo → confirmed; falta saldo → pending.
  const status = total_hnl !== null && paid_hnl >= total_hnl ? "confirmed" : "pending";

  try {
    const res = await env.DB.prepare(
      `UPDATE reservations
          SET total_hnl = ?, paid_hnl = ?, status = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(total_hnl, paid_hnl, status, id).run();
    if (!res.meta || res.meta.changes === 0) {
      return json({ ok: false, error: "No se encontró esa reserva." }, 404);
    }
    return json({ ok: true, status });
  } catch (err) {
    const msg = (err as Error).message || "";
    if (/no such column|total_hnl|paid_hnl/i.test(msg)) {
      return json({ ok: false, error: "Falta aplicar la actualización de la base (columnas de pago en LPS). Pegá en Cloudflare el SQL que te pasé y reintentá." }, 500);
    }
    return json({ ok: false, error: `D1: ${msg}` }, 500);
  }
};
