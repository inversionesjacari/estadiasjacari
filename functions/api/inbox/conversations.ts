/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/conversations
//
// Devuelve la lista de conversaciones (agrupadas por número del huésped) con
// el último mensaje, timestamp y cantidad de mensajes sin leer (en este MVP
// no hay "leído/no leído" — la cuenta es del total).
//
// Diseño SQLite: usa subquery con MAX(created_at) para sacar el último mensaje
// por número. Para 10k mensajes es OK; si crece a 100k+ habría que agregar
// una tabla `conversations` materializada.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
}

interface ConversationRow {
  phone: string;
  last_message: string;
  last_direction: "in" | "out";
  last_at: string;
  message_count: number;
  last_matched_rule: string | null;
  last_escalated: number;
  guest_name: string | null;
  property_slug: string | null;
  reservation_id: number | null;
  check_in: string | null;
  check_out: string | null;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  try {
    // Subconsulta: por cada phone, traer el mensaje más reciente.
    // LEFT JOIN reservations para tener contexto del huésped si existe.
    const { results } = await env.DB.prepare(
      `WITH last_msg AS (
         SELECT m.from_phone AS phone,
                m.body,
                m.direction,
                m.created_at,
                m.matched_rule,
                m.escalated,
                m.reservation_id,
                ROW_NUMBER() OVER (PARTITION BY m.from_phone ORDER BY m.created_at DESC) AS rn
           FROM whatsapp_messages m
          WHERE m.direction = 'in'
       )
       SELECT lm.phone,
              lm.body AS last_message,
              lm.direction AS last_direction,
              lm.created_at AS last_at,
              lm.matched_rule AS last_matched_rule,
              lm.escalated AS last_escalated,
              (SELECT COUNT(*) FROM whatsapp_messages m2 WHERE m2.from_phone = lm.phone OR m2.to_phone = lm.phone) AS message_count,
              r.guest_name,
              r.property_slug,
              r.id AS reservation_id,
              r.check_in,
              r.check_out
         FROM last_msg lm
         LEFT JOIN reservations r ON r.id = lm.reservation_id
        WHERE lm.rn = 1
        ORDER BY lm.created_at DESC
        LIMIT 100`,
    ).all<ConversationRow>();

    return json({
      ok: true,
      conversations: (results ?? []).map((r) => ({
        phone: r.phone,
        lastMessage: r.last_message?.slice(0, 200) ?? "",
        lastDirection: r.last_direction,
        lastAt: r.last_at,
        messageCount: r.message_count,
        lastMatchedRule: r.last_matched_rule,
        escalated: r.last_escalated === 1,
        reservation: r.reservation_id
          ? {
              id: r.reservation_id,
              guestName: r.guest_name,
              propertySlug: r.property_slug,
              checkIn: r.check_in,
              checkOut: r.check_out,
            }
          : null,
      })),
    });
  } catch (err) {
    return json(
      { ok: false, error: `Error consultando D1: ${(err as Error).message}` },
      500,
    );
  }
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
