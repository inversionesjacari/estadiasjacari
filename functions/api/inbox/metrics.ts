/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/metrics
//
// Métricas de operación en tiempo real para el Centro de Control (/inbox/operacion).
// Solo lectura sobre D1 (+ un check cacheado de Airbnb). Protegido con la cookie
// de sesión del inbox.
//
// Etapa 1: mensajes, conversaciones, embudo, reservas.
// Etapa 2: salud de sistemas, feed de actividad, tendencia 7 días, salud del bot.
// (Ver 05_automatizacion/06_plan_centro_control.md)
//
// Zona horaria: D1 guarda created_at en UTC. "Hoy" = día calendario Honduras
// (UTC-6). "Semana"/"mes" = ventanas relativas (7 / 30 días).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { getBlockedDates, type IcalEnv } from "../../_lib/availability";

interface Env extends IcalEnv {
  DB: D1Database;
  CRON_SECRET?: string;
  INBOX_PASSWORD?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Inicio del día de hoy en Honduras, en UTC, para comparar con created_at. */
const HN_DAY_START = "datetime('now','-6 hours','start of day','+6 hours')";

// Helpers para resultados fail-soft
type Rows<T> = { results?: T[] };
const rowsOf = <T>(r: unknown): T[] => (r as Rows<T>)?.results ?? [];
const numOf = (r: unknown, key: string): number =>
  ((r as Record<string, unknown>)?.[key] as number) ?? 0;
const strOf = (r: unknown, key: string): string | null =>
  ((r as Record<string, unknown>)?.[key] as string) ?? null;

interface FeedMsgRow {
  direction: string;
  body: string | null;
  from_phone: string;
  to_phone: string;
  escalated: number;
  matched_rule: string | null;
  created_at: string;
}
interface FeedResvRow {
  property_slug: string;
  guest_name: string | null;
  source: string;
  created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const db = env.DB;

  const [
    msgsToday, msgsWeek, uniqueToday, uniqueWeek, funnelRows,
    resvCounts, resvByProperty, resvBySource, revenueWeek,
    lastIn, lastOut, lastResv, heartbeat,
    botCounts, trendRows, feedMsgs, feedResvs,
  ] = await Promise.all([
    db.prepare(`SELECT direction, COUNT(*) AS c FROM whatsapp_messages WHERE created_at >= ${HN_DAY_START} GROUP BY direction`).all<{ direction: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT direction, COUNT(*) AS c FROM whatsapp_messages WHERE created_at >= datetime('now','-7 days') GROUP BY direction`).all<{ direction: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT COUNT(DISTINCT from_phone) AS c FROM whatsapp_messages WHERE direction='in' AND created_at >= ${HN_DAY_START}`).first<{ c: number }>().catch(() => ({ c: 0 })),
    db.prepare(`SELECT COUNT(DISTINCT from_phone) AS c FROM whatsapp_messages WHERE direction='in' AND created_at >= datetime('now','-7 days')`).first<{ c: number }>().catch(() => ({ c: 0 })),
    db.prepare(`SELECT state, COUNT(*) AS c FROM conversation_state WHERE expires_at > datetime('now') GROUP BY state`).all<{ state: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT SUM(CASE WHEN created_at >= ${HN_DAY_START} THEN 1 ELSE 0 END) AS today, SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS week, SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS month FROM reservations WHERE status IN ('pending','confirmed')`).first<{ today: number; week: number; month: number }>().catch(() => ({ today: 0, week: 0, month: 0 })),
    db.prepare(`SELECT property_slug AS slug, COUNT(*) AS c FROM reservations WHERE status IN ('pending','confirmed') AND created_at >= datetime('now','-30 days') GROUP BY property_slug ORDER BY c DESC`).all<{ slug: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT source, COUNT(*) AS c FROM reservations WHERE status IN ('pending','confirmed') AND created_at >= datetime('now','-30 days') GROUP BY source ORDER BY c DESC`).all<{ source: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT COALESCE(SUM(amount_usd),0) AS rev FROM reservations WHERE status IN ('pending','confirmed') AND created_at >= datetime('now','-7 days')`).first<{ rev: number }>().catch(() => ({ rev: 0 })),
    // Salud — última actividad por sistema
    db.prepare(`SELECT MAX(created_at) AS t FROM whatsapp_messages WHERE direction='in'`).first<{ t: string }>().catch(() => ({ t: null })),
    db.prepare(`SELECT MAX(created_at) AS t FROM whatsapp_messages WHERE direction='out'`).first<{ t: string }>().catch(() => ({ t: null })),
    db.prepare(`SELECT MAX(created_at) AS t FROM reservations`).first<{ t: string }>().catch(() => ({ t: null })),
    db.prepare(`SELECT last_at AS t FROM system_heartbeat WHERE key='cron_followups'`).first<{ t: string }>().catch(() => ({ t: null })),
    // Salud del bot (últimos 7 días)
    db.prepare(`SELECT
        SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) AS inbound,
        SUM(CASE WHEN direction='out' AND matched_rule='manual_inbox' THEN 1 ELSE 0 END) AS manual,
        SUM(CASE WHEN direction='out' AND matched_rule='bot_failed' THEN 1 ELSE 0 END) AS fails,
        SUM(CASE WHEN direction='out' AND escalated=1 THEN 1 ELSE 0 END) AS escalations,
        SUM(CASE WHEN direction='out' AND COALESCE(matched_rule,'') NOT IN ('manual_inbox','bot_failed') AND escalated=0 THEN 1 ELSE 0 END) AS botReplies
      FROM whatsapp_messages WHERE created_at >= datetime('now','-7 days')`).first<{ inbound: number; manual: number; fails: number; escalations: number; botReplies: number }>().catch(() => ({ inbound: 0, manual: 0, fails: 0, escalations: 0, botReplies: 0 })),
    // Tendencia: mensajes por día HN (últimos 7 días)
    db.prepare(`SELECT date(created_at,'-6 hours') AS day, COUNT(*) AS c FROM whatsapp_messages WHERE created_at >= datetime('now','-7 days') GROUP BY day ORDER BY day`).all<{ day: string; c: number }>().catch(() => ({ results: [] })),
    // Feed: últimos mensajes + reservas
    db.prepare(`SELECT direction, body, from_phone, to_phone, escalated, matched_rule, created_at FROM whatsapp_messages ORDER BY created_at DESC, id DESC LIMIT 12`).all<FeedMsgRow>().catch(() => ({ results: [] })),
    db.prepare(`SELECT property_slug, guest_name, source, created_at FROM reservations ORDER BY created_at DESC LIMIT 5`).all<FeedResvRow>().catch(() => ({ results: [] })),
  ]);

  // Airbnb health (cacheado 15 min por el fetch; no golpea Airbnb en cada poll)
  let airbnbStatus: "full" | "partial" | "unavailable" | "unknown" = "unknown";
  try {
    const blocked = await getBlockedDates("villa-b11-palma-real", env);
    if (blocked) airbnbStatus = blocked.airbnbSyncStatus;
  } catch {
    airbnbStatus = "unknown";
  }

  // ── Normalizar ──────────────────────────────────────────────────────────────
  const dir = (r: unknown, d: string) =>
    rowsOf<{ direction: string; c: number }>(r).find((x) => x.direction === d)?.c ?? 0;
  const funnel = rowsOf<{ state: string; c: number }>(funnelRows);
  const fc = (s: string) => funnel.find((r) => r.state === s)?.c ?? 0;

  // Feed unificado (mensajes + reservas), ordenado por fecha desc
  type FeedItem = { type: "message" | "reservation"; at: string; text: string; tag?: string };
  const feed: FeedItem[] = [];
  for (const r of rowsOf<FeedMsgRow>(feedMsgs)) {
    const isOut = r.direction === "out";
    const who = isOut ? r.to_phone : r.from_phone;
    const snippet = (r.body ?? "").replace(/\s+/g, " ").slice(0, 60);
    feed.push({
      type: "message",
      at: r.created_at,
      text: `${isOut ? "→" : "←"} ${who}: ${snippet}`,
      tag: r.escalated ? "escalado" : r.matched_rule === "bot_failed" ? "fallo" : undefined,
    });
  }
  for (const r of rowsOf<FeedResvRow>(feedResvs)) {
    feed.push({
      type: "reservation",
      at: r.created_at,
      text: `🏠 Reserva: ${r.property_slug}${r.guest_name ? ` · ${r.guest_name}` : ""}`,
      tag: r.source,
    });
  }
  feed.sort((a, b) => (a.at < b.at ? 1 : -1));

  const bc = botCounts as { inbound: number; manual: number; fails: number; escalations: number; botReplies: number };
  const escalationPct = bc.inbound > 0 ? Math.round((bc.escalations / bc.inbound) * 100) : 0;

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    messages: {
      todayIn: dir(msgsToday, "in"),
      todayOut: dir(msgsToday, "out"),
      weekIn: dir(msgsWeek, "in"),
      weekOut: dir(msgsWeek, "out"),
      uniqueToday: numOf(uniqueToday, "c"),
      uniqueWeek: numOf(uniqueWeek, "c"),
    },
    funnel: {
      awaitingData: fc("awaiting_quote_data"),
      quoteProvided: fc("quote_provided"),
      awaitingPaymentMethod: fc("awaiting_payment_method"),
      awaitingPaypal: fc("awaiting_paypal_capture"),
      awaitingTransfer: fc("awaiting_transfer_proof"),
      total: funnel.reduce((s, r) => s + r.c, 0),
    },
    reservations: {
      today: numOf(resvCounts, "today"),
      week: numOf(resvCounts, "week"),
      month: numOf(resvCounts, "month"),
      byProperty: rowsOf<{ slug: string; c: number }>(resvByProperty),
      bySource: rowsOf<{ source: string; c: number }>(resvBySource),
      revenueWeekUsd: Math.round(numOf(revenueWeek, "rev")),
    },
    health: {
      lastInAt: strOf(lastIn, "t"),
      lastOutAt: strOf(lastOut, "t"),
      lastReservationAt: strOf(lastResv, "t"),
      cronLastAt: strOf(heartbeat, "t"),
      airbnbStatus,
    },
    botHealth: {
      inbound: bc.inbound,
      botReplies: bc.botReplies,
      manualReplies: bc.manual,
      escalations: bc.escalations,
      fails: bc.fails,
      escalationPct,
    },
    trend: rowsOf<{ day: string; c: number }>(trendRows),
    feed: feed.slice(0, 15),
  });
};
