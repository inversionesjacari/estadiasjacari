/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/conversations
//
// Devuelve la lista de conversaciones (agrupadas por número del huésped) con
// el último mensaje, timestamp y cantidad de mensajes.
//
// B9 "El inbox completo" (2026-07-11): antes esto era un `LIMIT 100` pelado sin
// paginación ni búsqueda. Con >100 leads/día eso mostraba ~1 día y —el bug más
// caro— un chat ESCALADO/PAUSADO/esperando-pago de hace 3 días caía fuera de los
// 100 y desaparecía de la cola de trabajo de César. Ahora:
//   - `?before=<last_at>`  → paginación por CURSOR (keyset sobre lm.created_at,
//                            que ya ordena el query). Nada de OFFSET: no se
//                            desalinea cuando entran mensajes nuevos entre páginas.
//   - `?q=<texto>`         → búsqueda server-side por teléfono / nombre de perfil
//                            / nombre de huésped (con historial largo, scrollear
//                            no es buscar).
//   - PENDIENTES SIEMPRE   → en la primera carga (sin cursor ni búsqueda) se traen
//                            TODOS los chats escalados/pausados/en-pago aunque sean
//                            viejos y estén fuera de los 100 recientes, y se
//                            fusionan con el feed. splitPendientes() en el front los
//                            recoge → la cola de trabajo nunca se corta.
//
// Diseño SQLite: subquery con ROW_NUMBER() para el último mensaje entrante por
// número. Para 10k mensajes es OK; a 100k+ tocaría una tabla `conversations`
// materializada.
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
  contact_name: string | null;
  guest_name: string | null;
  property_slug: string | null;
  reservation_id: number | null;
  check_in: string | null;
  check_out: string | null;
  conv_state: string | null;
  tag_outcome: string | null;
  tag_property: string | null;
  tag_by: string | null;
  last_out_at: string | null;
  last_out_body: string | null;
  last_out_rule: string | null;
}

// Cuántas conversaciones trae una página del feed cronológico.
const FEED_LIMIT = 100;
// Tope de seguridad de la cola de pendientes (escalados/pausados/en-pago). Es la
// cola de trabajo, no un feed; en la práctica son decenas, no cientos.
const PENDING_LIMIT = 300;
// Estados de embudo de pago que cuentan como "pendiente" (en sync con PAY_STATES
// del front, src/app/inbox/page.tsx).
const PAY_STATES = ["awaiting_transfer_proof", "awaiting_paypal_capture", "awaiting_payment_method"];

/**
 * Cuerpo del SELECT de conversaciones, parametrizable por el WHERE extra y el
 * LIMIT. Se reusa para el feed, la búsqueda y los pendientes (mismo shape de fila).
 */
function conversationsQuery(whereExtra: string, limitClause: string): string {
  return `WITH last_msg AS (
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
              (SELECT MAX(m3.created_at) FROM whatsapp_messages m3 WHERE m3.to_phone = lm.phone AND m3.direction = 'out') AS last_out_at,
              (SELECT m4.body FROM whatsapp_messages m4 WHERE m4.to_phone = lm.phone AND m4.direction = 'out' ORDER BY m4.created_at DESC, m4.id DESC LIMIT 1) AS last_out_body,
              (SELECT m5.matched_rule FROM whatsapp_messages m5 WHERE m5.to_phone = lm.phone AND m5.direction = 'out' AND m5.matched_rule IS NOT NULL ORDER BY m5.created_at DESC, m5.id DESC LIMIT 1) AS last_out_rule,
              c.profile_name AS contact_name,
              r.guest_name,
              r.property_slug,
              r.id AS reservation_id,
              r.check_in,
              r.check_out,
              st.state AS conv_state,
              ct.outcome AS tag_outcome,
              ct.property_slug AS tag_property,
              ct.tagged_by AS tag_by
         FROM last_msg lm
         LEFT JOIN reservations r ON r.id = lm.reservation_id
         LEFT JOIN whatsapp_contacts c ON c.phone = lm.phone
         LEFT JOIN conversation_state st ON st.phone = lm.phone AND st.expires_at > datetime('now')
         LEFT JOIN conversation_tags ct ON ct.phone = lm.phone
        WHERE lm.rn = 1 ${whereExtra}
        ORDER BY lm.created_at DESC
        ${limitClause}`;
}

/**
 * Fusiona pendientes + feed en una sola lista, deduplicada por teléfono, ordenada
 * por último mensaje (desc). Los pendientes que también están en el feed no se
 * duplican; los pendientes viejos que NO están en el feed quedan igual incluidos
 * (ese es el punto: que la cola de trabajo no se corte). Función pura y testeable.
 */
export function mergeByPhone(pending: ConversationRow[], feed: ConversationRow[]): ConversationRow[] {
  const byPhone = new Map<string, ConversationRow>();
  for (const r of pending) byPhone.set(r.phone, r);
  for (const r of feed) if (!byPhone.has(r.phone)) byPhone.set(r.phone, r);
  return [...byPhone.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
}

/**
 * Cursor para la siguiente página: el last_at del feed más viejo, SOLO si el feed
 * vino lleno (o sea, probablemente hay más). null cuando no hay más que cargar.
 * Función pura y testeable.
 */
export function nextCursorOf(feed: ConversationRow[], limit: number): string | null {
  if (feed.length < limit) return null;
  return feed[feed.length - 1]?.last_at ?? null;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const before = (url.searchParams.get("before") || "").trim();

  try {
    let feed: ConversationRow[];
    let pending: ConversationRow[] = [];
    let nextCursor: string | null = null;

    if (q) {
      // ── Modo BÚSQUEDA: por teléfono / nombre de perfil / nombre de huésped.
      const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
      const res = await env.DB.prepare(
        conversationsQuery(
          `AND (lm.phone LIKE ?1 ESCAPE '\\' OR c.profile_name LIKE ?1 ESCAPE '\\' OR r.guest_name LIKE ?1 ESCAPE '\\')`,
          `LIMIT 60`,
        ),
      ).bind(like).all<ConversationRow>();
      feed = res.results ?? [];
    } else {
      // ── Modo NORMAL: feed paginado por cursor.
      const feedRes = before
        ? await env.DB.prepare(conversationsQuery(`AND lm.created_at < ?1`, `LIMIT ${FEED_LIMIT}`)).bind(before).all<ConversationRow>()
        : await env.DB.prepare(conversationsQuery(``, `LIMIT ${FEED_LIMIT}`)).all<ConversationRow>();
      feed = feedRes.results ?? [];
      nextCursor = nextCursorOf(feed, FEED_LIMIT);

      // Solo en la PRIMERA carga (sin cursor) traemos la cola de pendientes completa,
      // sin importar antigüedad, para que un escalado/pausado/en-pago viejo NO
      // desaparezca. Fail-soft: si `bot_pauses` no existe o la query falla, el inbox
      // sigue con el feed (comportamiento previo).
      if (!before) {
        try {
          const payList = PAY_STATES.map((s) => `'${s}'`).join(",");
          const pendRes = await env.DB.prepare(
            conversationsQuery(
              `AND (lm.escalated = 1
                    OR lm.phone IN (SELECT phone FROM bot_pauses)
                    OR st.state IN (${payList}))`,
              `LIMIT ${PENDING_LIMIT}`,
            ),
          ).all<ConversationRow>();
          pending = pendRes.results ?? [];
        } catch {
          /* bot_pauses ausente u otro fallo → sin cola extra, solo feed */
        }
      }
    }

    const rows = mergeByPhone(pending, feed);

    // Teléfonos con el bot pausado (handoff a humano). Query aparte y fail-soft
    // para no romper el inbox si la tabla `bot_pauses` todavía no está aplicada.
    let paused = new Set<string>();
    try {
      const p = await env.DB.prepare(`SELECT phone FROM bot_pauses`).all<{ phone: string }>();
      paused = new Set((p.results ?? []).map((x) => x.phone));
    } catch {
      /* tabla no existe todavía → ningún número pausado */
    }

    // Descartados de "Pendientes" (botón ✕): phone → dismissed_at. Fail-soft.
    let dismissed = new Map<string, string>();
    try {
      const d = await env.DB.prepare(`SELECT phone, dismissed_at FROM pendientes_dismissed`).all<{ phone: string; dismissed_at: string }>();
      dismissed = new Map((d.results ?? []).map((x) => [x.phone, x.dismissed_at]));
    } catch {
      /* tabla no existe todavía → ninguno descartado */
    }

    return json({
      ok: true,
      nextCursor,
      conversations: rows.map((r) => {
        // Preview = el mensaje MÁS RECIENTE del chat, sea del cliente (in) o
        // ENVIADO por el bot/equipo (out). Pedido de César: ver en la lista la
        // última respuesta enviada, no solo lo último que escribió el cliente.
        const outNewer = r.last_out_at != null && r.last_out_at >= r.last_at;
        const preview = (outNewer ? r.last_out_body : r.last_message)?.slice(0, 200) ?? "";
        return {
          phone: r.phone,
          lastMessage: preview,
          lastDirection: outNewer ? "out" : "in",
          lastAt: r.last_at,
          messageCount: r.message_count,
          lastMatchedRule: r.last_matched_rule,
          escalated: r.last_escalated === 1,
          botPaused: paused.has(r.phone),
          dismissed: ((da) => da != null && da >= r.last_at)(dismissed.get(r.phone)),
          state: r.conv_state,
          tag: r.tag_outcome ? { outcome: r.tag_outcome, propertySlug: r.tag_property ?? null, by: r.tag_by ?? "manual" } : null,
          lastOutAt: r.last_out_at,
          lastOutRule: r.last_out_rule,
          contactName: r.contact_name,
          reservation: r.reservation_id
            ? {
                id: r.reservation_id,
                guestName: r.guest_name,
                propertySlug: r.property_slug,
                checkIn: r.check_in,
                checkOut: r.check_out,
              }
            : null,
        };
      }),
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
