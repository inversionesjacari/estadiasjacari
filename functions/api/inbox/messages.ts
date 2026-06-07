/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/messages?phone=<E.164 sin '+'>
//
// Devuelve el historial completo de mensajes (entrantes + salientes) con un
// número específico. Ordenados cronológicamente ASC (los más viejos primero,
// listos para renderizar el scroll del chat).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
}

interface MessageRow {
  id: number;
  meta_message_id: string | null;
  reservation_id: number | null;
  direction: "in" | "out";
  from_phone: string;
  to_phone: string;
  body: string | null;
  matched_rule: string | null;
  escalated: number;
  status: string | null;
  created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const phone = url.searchParams.get("phone");
  if (!phone || !/^\d{8,15}$/.test(phone)) {
    return json({ ok: false, error: "Query param 'phone' requerido (8-15 dígitos, sin '+')" }, 400);
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, meta_message_id, reservation_id, direction,
              from_phone, to_phone, body, matched_rule, escalated, status, created_at
         FROM whatsapp_messages
        WHERE from_phone = ? OR to_phone = ?
        ORDER BY created_at ASC
        LIMIT 500`,
    )
      .bind(phone, phone)
      .all<MessageRow>();

    return json({
      ok: true,
      phone,
      messages: (results ?? []).map((m) => ({
        id: m.id,
        metaMessageId: m.meta_message_id,
        reservationId: m.reservation_id,
        direction: m.direction,
        fromPhone: m.from_phone,
        toPhone: m.to_phone,
        body: m.body ?? "",
        matchedRule: m.matched_rule,
        escalated: m.escalated === 1,
        status: m.status,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    return json({ ok: false, error: `Error D1: ${(err as Error).message}` }, 500);
  }
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
