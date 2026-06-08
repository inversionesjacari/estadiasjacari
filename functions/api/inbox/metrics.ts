/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/metrics
//
// Métricas de operación en tiempo real para el Centro de Control (/inbox/operacion).
// Solo lectura sobre D1. Protegido con la cookie de sesión del inbox.
//
// Etapa 1: mensajes, conversaciones, embudo de ventas, reservas.
// (Etapas 2-3 añaden salud del sistema, feed y diagrama — ver
//  05_automatizacion/06_plan_centro_control.md)
//
// Zona horaria: D1 guarda created_at en UTC. "Hoy" = día calendario Honduras
// (UTC-6) → inicio del día HN en UTC = datetime('now','-6 hours','start of day','+6 hours').
// "Semana" y "mes" son ventanas relativas (últimos 7 / 30 días).
//

import { requireInboxAuth } from "../../_lib/inbox-auth";

interface Env {
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

/** Inicio del día de hoy en Honduras, expresado en UTC para comparar con created_at. */
const HN_DAY_START = "datetime('now','-6 hours','start of day','+6 hours')";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const db = env.DB;

  // Ejecutamos todas las consultas en paralelo. Cada una es fail-soft:
  // si falla, su rama devuelve el default y el resto del dashboard sigue.
  const [
    msgsToday,
    msgsWeek,
    uniqueToday,
    uniqueWeek,
    funnelRows,
    resvCounts,
    resvByProperty,
    resvBySource,
    revenueWeek,
  ] = await Promise.all([
    // Mensajes hoy por dirección
    db.prepare(
      `SELECT direction, COUNT(*) AS c FROM whatsapp_messages
        WHERE created_at >= ${HN_DAY_START} GROUP BY direction`,
    ).all<{ direction: string; c: number }>().catch(() => ({ results: [] })),

    // Mensajes últimos 7 días por dirección
    db.prepare(
      `SELECT direction, COUNT(*) AS c FROM whatsapp_messages
        WHERE created_at >= datetime('now','-7 days') GROUP BY direction`,
    ).all<{ direction: string; c: number }>().catch(() => ({ results: [] })),

    // Conversaciones únicas hoy (números distintos que escribieron)
    db.prepare(
      `SELECT COUNT(DISTINCT from_phone) AS c FROM whatsapp_messages
        WHERE direction='in' AND created_at >= ${HN_DAY_START}`,
    ).first<{ c: number }>().catch(() => ({ c: 0 })),

    // Conversaciones únicas últimos 7 días
    db.prepare(
      `SELECT COUNT(DISTINCT from_phone) AS c FROM whatsapp_messages
        WHERE direction='in' AND created_at >= datetime('now','-7 days')`,
    ).first<{ c: number }>().catch(() => ({ c: 0 })),

    // Embudo: conversaciones activas por estado (no expiradas)
    db.prepare(
      `SELECT state, COUNT(*) AS c FROM conversation_state
        WHERE expires_at > datetime('now') GROUP BY state`,
    ).all<{ state: string; c: number }>().catch(() => ({ results: [] })),

    // Reservas hoy / semana / mes (pending + confirmed)
    db.prepare(
      `SELECT
         SUM(CASE WHEN created_at >= ${HN_DAY_START} THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS week,
         SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS month
       FROM reservations
       WHERE status IN ('pending','confirmed')`,
    ).first<{ today: number; week: number; month: number }>().catch(() => ({
      today: 0, week: 0, month: 0,
    })),

    // Reservas por propiedad (últimos 30 días)
    db.prepare(
      `SELECT property_slug AS slug, COUNT(*) AS c FROM reservations
        WHERE status IN ('pending','confirmed') AND created_at >= datetime('now','-30 days')
        GROUP BY property_slug ORDER BY c DESC`,
    ).all<{ slug: string; c: number }>().catch(() => ({ results: [] })),

    // Reservas por fuente (últimos 30 días)
    db.prepare(
      `SELECT source, COUNT(*) AS c FROM reservations
        WHERE status IN ('pending','confirmed') AND created_at >= datetime('now','-30 days')
        GROUP BY source ORDER BY c DESC`,
    ).all<{ source: string; c: number }>().catch(() => ({ results: [] })),

    // Ingresos últimos 7 días (USD)
    db.prepare(
      `SELECT COALESCE(SUM(amount_usd),0) AS rev FROM reservations
        WHERE status IN ('pending','confirmed') AND created_at >= datetime('now','-7 days')`,
    ).first<{ rev: number }>().catch(() => ({ rev: 0 })),
  ]);

  // ── Normalizar resultados ──────────────────────────────────────────────────
  const dirCount = (rows: { direction: string; c: number }[], dir: string) =>
    rows.find((r) => r.direction === dir)?.c ?? 0;

  const todayRows = (msgsToday as { results?: { direction: string; c: number }[] }).results ?? [];
  const weekRows = (msgsWeek as { results?: { direction: string; c: number }[] }).results ?? [];
  const funnel = (funnelRows as { results?: { state: string; c: number }[] }).results ?? [];

  const funnelCount = (state: string) => funnel.find((r) => r.state === state)?.c ?? 0;

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    messages: {
      todayIn: dirCount(todayRows, "in"),
      todayOut: dirCount(todayRows, "out"),
      weekIn: dirCount(weekRows, "in"),
      weekOut: dirCount(weekRows, "out"),
      uniqueToday: (uniqueToday as { c: number }).c ?? 0,
      uniqueWeek: (uniqueWeek as { c: number }).c ?? 0,
    },
    funnel: {
      awaitingData: funnelCount("awaiting_quote_data"),
      quoteProvided: funnelCount("quote_provided"),
      awaitingPaymentMethod: funnelCount("awaiting_payment_method"),
      awaitingPaypal: funnelCount("awaiting_paypal_capture"),
      awaitingTransfer: funnelCount("awaiting_transfer_proof"),
      total: funnel.reduce((s, r) => s + r.c, 0),
    },
    reservations: {
      today: (resvCounts as { today: number }).today ?? 0,
      week: (resvCounts as { week: number }).week ?? 0,
      month: (resvCounts as { month: number }).month ?? 0,
      byProperty:
        (resvByProperty as { results?: { slug: string; c: number }[] }).results ?? [],
      bySource:
        (resvBySource as { results?: { source: string; c: number }[] }).results ?? [],
      revenueWeekUsd: Math.round((revenueWeek as { rev: number }).rev ?? 0),
    },
  });
};
