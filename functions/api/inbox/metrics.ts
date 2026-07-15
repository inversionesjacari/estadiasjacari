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
import { getBlockedDates, SLUG_TO_SOURCES, type IcalEnv } from "../../_lib/availability";
import { isNotInterested } from "../../_lib/detectors";
import { metaCodeLabel, parseWaFailTrace } from "../../_lib/delivery-policy";

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

  // Mes a mostrar: ?month=YYYY-MM (default = mes calendario actual en Honduras,
  // UTC-6). Es la base de Reservas/Ingresos/por-propiedad, TODO por CHECK-IN
  // (cuándo ocurre la estadía) — no por created_at, para que el backfill de
  // Airbnb no meta el histórico en "hoy".
  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month");
  const hnNow = new Date(Date.now() - 6 * 3600 * 1000);
  let mY = hnNow.getUTCFullYear();
  let mM = hnNow.getUTCMonth();
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [py, pm] = monthParam.split("-").map(Number);
    if (py >= 2020 && py <= 2100 && pm >= 1 && pm <= 12) { mY = py; mM = pm - 1; }
  }
  const monthPrefix = `${mY}-${String(mM + 1).padStart(2, "0")}`;
  const monthStart = `${monthPrefix}-01`;
  const nextMonthStart = new Date(Date.UTC(mY, mM + 1, 1)).toISOString().slice(0, 10);
  const daysInMonth = new Date(Date.UTC(mY, mM + 1, 0)).getUTCDate();

  const [
    msgsToday, msgsWeek, msgRanges, convRanges, funnelRows,
    resvCounts, resvByProperty, resvBySource, revRanges,
    lastIn, lastOut, lastResv, heartbeat,
    botCounts, trendRows, feedMsgs, feedResvs,
    webToday, webYesterday, webWeek, webNow, webTopPages, webSources, webTrend, airbnbIncome,
    qaFindings, qaLastRun,
    revByProperty,
    failuresByIssue, traceByStage, escalationsByRule,
  ] = await Promise.all([
    db.prepare(`SELECT direction, COUNT(*) AS c FROM whatsapp_messages WHERE created_at >= ${HN_DAY_START} GROUP BY direction`).all<{ direction: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT direction, COUNT(*) AS c FROM whatsapp_messages WHERE created_at >= datetime('now','-7 days') GROUP BY direction`).all<{ direction: string; c: number }>().catch(() => ({ results: [] })),
    // Totales de mensajes por rango (hoy / 7d / 30d)
    db.prepare(`SELECT SUM(CASE WHEN created_at >= ${HN_DAY_START} THEN 1 ELSE 0 END) AS today, SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS week, SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS month FROM whatsapp_messages`).first<{ today: number; week: number; month: number }>().catch(() => ({ today: 0, week: 0, month: 0 })),
    // Conversaciones únicas (teléfonos distintos que escribieron) por rango
    db.prepare(`SELECT COUNT(DISTINCT CASE WHEN created_at >= ${HN_DAY_START} THEN from_phone END) AS today, COUNT(DISTINCT CASE WHEN created_at >= datetime('now','-7 days') THEN from_phone END) AS week, COUNT(DISTINCT CASE WHEN created_at >= datetime('now','-30 days') THEN from_phone END) AS month FROM whatsapp_messages WHERE direction='in'`).first<{ today: number; week: number; month: number }>().catch(() => ({ today: 0, week: 0, month: 0 })),
    db.prepare(`SELECT state, COUNT(*) AS c FROM conversation_state WHERE expires_at > datetime('now') GROUP BY state`).all<{ state: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT SUM(CASE WHEN created_at >= ${HN_DAY_START} THEN 1 ELSE 0 END) AS today, SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS week, SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS month FROM reservations WHERE status IN ('pending','confirmed')`).first<{ today: number; week: number; month: number }>().catch(() => ({ today: 0, week: 0, month: 0 })),
    db.prepare(`SELECT property_slug AS slug, COUNT(*) AS c FROM reservations WHERE status IN ('pending','confirmed') AND created_at >= datetime('now','-30 days') GROUP BY property_slug ORDER BY c DESC`).all<{ slug: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT source, COUNT(*) AS c FROM reservations WHERE status IN ('pending','confirmed') AND created_at >= datetime('now','-30 days') GROUP BY source ORDER BY c DESC`).all<{ source: string; c: number }>().catch(() => ({ results: [] })),
    // Ingresos directos (reservas pagadas/pendientes en D1) por rango. Airbnb se
    // sumará aparte vía PayPal Transaction Search cuando se active.
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN created_at >= ${HN_DAY_START} THEN amount_usd ELSE 0 END),0) AS today, COALESCE(SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN amount_usd ELSE 0 END),0) AS week, COALESCE(SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN amount_usd ELSE 0 END),0) AS month FROM reservations WHERE status IN ('pending','confirmed')`).first<{ today: number; week: number; month: number }>().catch(() => ({ today: 0, week: 0, month: 0 })),
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
    // Tráfico web (page_views) — fail-soft si la tabla no existe aún
    db.prepare(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS uniques FROM page_views WHERE created_at >= ${HN_DAY_START}`).first<{ views: number; uniques: number }>().catch(() => ({ views: 0, uniques: 0 })),
    // Ayer (día calendario HN anterior) — base del delta "vs ayer"
    db.prepare(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS uniques FROM page_views WHERE created_at >= datetime('now','-6 hours','start of day','-1 day','+6 hours') AND created_at < ${HN_DAY_START}`).first<{ views: number; uniques: number }>().catch(() => ({ views: 0, uniques: 0 })),
    // Últimos 7 días (escala agregada)
    db.prepare(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS uniques FROM page_views WHERE created_at >= datetime('now','-7 days')`).first<{ views: number; uniques: number }>().catch(() => ({ views: 0, uniques: 0 })),
    db.prepare(`SELECT COUNT(DISTINCT visitor) AS c FROM page_views WHERE created_at >= datetime('now','-5 minutes')`).first<{ c: number }>().catch(() => ({ c: 0 })),
    db.prepare(`SELECT path, COUNT(*) AS c FROM page_views WHERE created_at >= ${HN_DAY_START} GROUP BY path ORDER BY c DESC LIMIT 6`).all<{ path: string; c: number }>().catch(() => ({ results: [] })),
    // Origen del tráfico (7d) incluyendo el directo (sin referrer)
    db.prepare(`SELECT COALESCE(NULLIF(utm_source,''), NULLIF(referrer,''), '(directo)') AS referrer, COUNT(*) AS c FROM page_views WHERE created_at >= datetime('now','-7 days') GROUP BY 1 ORDER BY c DESC LIMIT 6`).all<{ referrer: string; c: number }>().catch(() => ({ results: [] })),
    // Tendencia diaria (7d) — vistas y únicos por día HN, alimenta el sparkline
    db.prepare(`SELECT date(created_at,'-6 hours') AS day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS uniques FROM page_views WHERE created_at >= datetime('now','-7 days') GROUP BY day ORDER BY day`).all<{ day: string; views: number; uniques: number }>().catch(() => ({ results: [] })),
    // Ingreso Airbnb cacheado (cron paypal-income). Fail-soft si la tabla no existe.
    db.prepare(`SELECT period, amount_usd FROM airbnb_income`).all<{ period: string; amount_usd: number }>().catch(() => ({ results: [] })),
    // QA del bot: hallazgos + última corrida. Fail-soft si las tablas no existen.
    db.prepare(`SELECT id, phone, issue, severity, detail, suggestion, conv_at FROM bot_qa_findings ORDER BY CASE severity WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, conv_at DESC, id`).all<{ id: number; phone: string; issue: string; severity: string; detail: string; suggestion: string; conv_at: string }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT ran_at, analyzed, found, trigger FROM bot_qa_runs ORDER BY id DESC LIMIT 1`).first<{ ran_at: string; analyzed: number; found: number; trigger: string }>().catch(() => null),
    // Ingresos + conteo por propiedad — reservas con llegada (check_in) en el mes calendario HN.
    // revNightsUsd = noches SOLO de las reservas que generan USD (Airbnb + directo-USD) →
    // denominador limpio del ADR (tarifa media por noche). Excluye las noches de reservas
    // en HNL puro (amount_usd=0) para no diluir el ADR en dólares con noches sin USD.
    db.prepare(`SELECT property_slug AS slug, COALESCE(SUM(amount_usd),0) AS revenue, COALESCE(SUM(total_hnl),0) AS revenueHnl, COUNT(*) AS reservas, COALESCE(SUM(CASE WHEN amount_usd > 0 THEN CAST(julianday(check_out)-julianday(check_in) AS INT) ELSE 0 END),0) AS revNightsUsd FROM reservations WHERE status IN ('pending','confirmed') AND check_in >= ? AND check_in < ? GROUP BY property_slug`).bind(monthStart, nextMonthStart).all<{ slug: string; revenue: number; revenueHnl: number; reservas: number; revNightsUsd: number }>().catch(() => ({ results: [] })),
    // ── DASHBOARD DE CATEGORÍAS DE FALLO (error analysis) ─────────────────────
    // Dónde falla el bot, agrupado, para arreglar la categoría más grande primero
    // (en vez de reaccionar chat por chat). Todo fail-soft.
    // (A) Hallazgos del QA agrupados por TIPO de problema (snapshot actual; el QA
    //     reemplaza sus hallazgos en cada corrida). + cuántos son severidad alta.
    db.prepare(`SELECT COALESCE(issue,'(sin categoría)') AS issue, COUNT(*) AS c, SUM(CASE WHEN severity='alta' THEN 1 ELSE 0 END) AS alta FROM bot_qa_findings GROUP BY issue ORDER BY c DESC, alta DESC LIMIT 10`).all<{ issue: string; c: number; alta: number }>().catch(() => ({ results: [] })),
    // (B) Trazas técnicas del bot (últimos 7 días) por etapa: LLM_GLITCH (modelo
    //     falló), THREW (excepción), DATE_PARSER_FIX (el parser corrigió una fecha
    //     mal razonada por el LLM → mide cuánto trabajo está haciendo la red nueva).
    db.prepare(`SELECT COALESCE(stage,'(sin etapa)') AS stage, COUNT(*) AS c FROM bot_trace WHERE at >= datetime('now','-7 days') GROUP BY stage ORDER BY c DESC`).all<{ stage: string; c: number }>().catch(() => ({ results: [] })),
    // (C) Escalaciones / fallos (últimos 7 días) por REGLA determinística que los
    //     disparó → muestra en qué punto el bot suelta al cliente a un humano.
    db.prepare(`SELECT COALESCE(NULLIF(matched_rule,''),'(sin regla)') AS rule, COUNT(*) AS c FROM whatsapp_messages WHERE direction='out' AND created_at >= datetime('now','-7 days') AND (escalated=1 OR matched_rule='bot_failed') GROUP BY rule ORDER BY c DESC LIMIT 8`).all<{ rule: string; c: number }>().catch(() => ({ results: [] })),
  ]);

  // ── EMBUDO DE CONVERSIÓN (pista del bot, sesión B3 — línea base) ─────────────
  // Cohorte = leads NUEVOS (primer 'in' de ese teléfono) en los últimos 30 días.
  // lead → cotizado (matched_rule='quote_provided', ya se graba en quote-flow.ts)
  // → pagado (join con reservations por guest_phone_normalized, canal WhatsApp).
  // Todo con tablas YA existentes — nada de dashboards ni tablas nuevas.
  const funnelRow = await db
    .prepare(`
      WITH first_in AS (
        SELECT from_phone AS phone, MIN(created_at) AS first_at
        FROM whatsapp_messages WHERE direction='in' GROUP BY from_phone
      ),
      cohort AS (SELECT phone FROM first_in WHERE first_at >= datetime('now','-30 days')),
      quoted AS (SELECT DISTINCT to_phone AS phone FROM whatsapp_messages WHERE direction='out' AND matched_rule='quote_provided'),
      paid AS (SELECT DISTINCT guest_phone_normalized AS phone FROM reservations WHERE source IN ('whatsapp_bot','whatsapp_transfer') AND status IN ('pending','confirmed') AND guest_phone_normalized IS NOT NULL)
      SELECT
        (SELECT COUNT(*) FROM cohort) AS leadsNew,
        (SELECT COUNT(*) FROM cohort c JOIN quoted q ON q.phone = c.phone) AS leadsQuoted,
        (SELECT COUNT(*) FROM cohort c JOIN paid p ON p.phone = c.phone) AS leadsPaid
    `)
    .first<{ leadsNew: number; leadsQuoted: number; leadsPaid: number }>()
    .catch(() => ({ leadsNew: 0, leadsQuoted: 0, leadsPaid: 0 }));

  // Latencia de primera respuesta (minutos) por lead de la MISMA cohorte — julianday()
  // hace la resta de fechas EN SQL (evita parsear el datetime "YYYY-MM-DD HH:MM:SS" de
  // SQLite a mano en JS); la mediana se calcula abajo, volumen mensual chico de sobra.
  const firstResponseRows = await db
    .prepare(`
      WITH first_in AS (
        SELECT from_phone AS phone, MIN(created_at) AS first_at
        FROM whatsapp_messages WHERE direction='in' GROUP BY from_phone
        HAVING MIN(created_at) >= datetime('now','-30 days')
      )
      SELECT
        (JULIANDAY((SELECT MIN(o.created_at) FROM whatsapp_messages o WHERE o.direction='out' AND o.to_phone = fi.phone AND o.created_at >= fi.first_at)) - JULIANDAY(fi.first_at)) * 24 * 60 AS minutes
      FROM first_in fi
    `)
    .all<{ minutes: number | null }>()
    .catch(() => ({ results: [] }));

  const responseMinutes = rowsOf<{ minutes: number | null }>(firstResponseRows)
    .map((r) => r.minutes)
    .filter((m): m is number => typeof m === "number" && Number.isFinite(m) && m >= 0)
    .sort((a, b) => a - b);
  const medianFirstResponseMin =
    responseMinutes.length === 0
      ? null
      : responseMinutes.length % 2 === 1
        ? responseMinutes[(responseMinutes.length - 1) / 2]
        : (responseMinutes[responseMinutes.length / 2 - 1] + responseMinutes[responseMinutes.length / 2]) / 2;

  // Efectividad de followups (30d): "respondió" NO es lo mismo que "se recuperó"
  // — un "gracias pero no tengo dinero" es una respuesta, pero es un rechazo, no
  // una recuperación (corrección de César tras ver la card: el 42% original
  // mezclaba ambas cosas). Traemos el PRIMER texto de respuesta de cada followup
  // y lo clasificamos en JS con isNotInterested (mismo detector que usa el bot en
  // el paso de pago) — no se puede clasificar dentro del SQL.
  const followupReplyRows = await db
    .prepare(`
      SELECT cs.phone AS phone,
        (SELECT m.body FROM whatsapp_messages m
           WHERE m.direction='in' AND m.from_phone = cs.phone AND m.created_at > cs.followup_sent_at
           ORDER BY m.created_at ASC LIMIT 1) AS reply_body
      FROM conversation_state cs
      WHERE cs.followup_sent_at IS NOT NULL AND cs.followup_sent_at >= datetime('now','-30 days')
    `)
    .all<{ phone: string; reply_body: string | null }>()
    .catch(() => ({ results: [] }));

  let followupSent = 0, followupDeclined = 0, followupStillInterested = 0, followupNoResponse = 0;
  for (const r of rowsOf<{ phone: string; reply_body: string | null }>(followupReplyRows)) {
    followupSent++;
    if (!r.reply_body) followupNoResponse++;
    else if (isNotInterested(r.reply_body)) followupDeclined++;
    else followupStillInterested++;
  }

  // Revenue por origen del lead (30d, por check_in de la reserva) — cruza
  // reservations con whatsapp_lead_source (ads Click-to-WhatsApp).
  const revenueByOriginRows = await db
    .prepare(`
      SELECT COALESCE(NULLIF(wls.headline,''), '(sin origen de ad)') AS origin,
        COALESCE(SUM(r.amount_usd),0) AS revenue, COUNT(*) AS reservas
      FROM reservations r
      LEFT JOIN whatsapp_lead_source wls ON wls.phone = r.guest_phone_normalized
      WHERE r.status IN ('pending','confirmed') AND r.created_at >= datetime('now','-30 days')
      GROUP BY origin ORDER BY revenue DESC LIMIT 10
    `)
    .all<{ origin: string; revenue: number; reservas: number }>()
    .catch(() => ({ results: [] }));

  // Ingreso del mes seleccionado por CHECK-IN, separado por moneda (USD vs HNL) +
  // desglose Airbnb vs directo. Nunca mezcla monedas en un solo total.
  const revMonthRow = await db
    .prepare(`SELECT
        COALESCE(SUM(amount_usd),0) AS usd,
        COALESCE(SUM(total_hnl),0) AS hnl,
        COALESCE(SUM(CASE WHEN source='airbnb' THEN amount_usd ELSE 0 END),0) AS usdAirbnb,
        COUNT(*) AS reservas
      FROM reservations
      WHERE status IN ('pending','confirmed') AND check_in >= ? AND check_in < ?`)
    .bind(monthStart, nextMonthStart)
    .first<{ usd: number; hnl: number; usdAirbnb: number; reservas: number }>()
    .catch(() => ({ usd: 0, hnl: 0, usdAirbnb: 0, reservas: 0 }));

  // Meses con reservas (por check_in) para el selector, más reciente primero.
  const availMonthsRows = await db
    .prepare(`SELECT DISTINCT substr(check_in,1,7) AS m FROM reservations WHERE status IN ('pending','confirmed') AND check_in IS NOT NULL AND check_in <> '' ORDER BY m DESC`)
    .all<{ m: string }>()
    .catch(() => ({ results: [] }));

  // ── Marketing: reporte del mes para el equipo de pauta ────────────────────────
  // Alcance (web + WhatsApp), canales (de dónde llegan), interés (qué anuncios
  // miran) y conversión (reservas por canal/propiedad). Mensajes y visitas usan
  // created_at (evento); 00:00 HN = 06:00 UTC. Reservas por check_in del mes.
  const monthStartUtc = `${monthStart} 06:00:00`;
  const nextMonthStartUtc = `${nextMonthStart} 06:00:00`;
  // Conversiones DIRECTAS = todo lo NO-Airbnb (sitio, bot, transferencia y las
  // reservas cargadas a mano desde el inbox). Es el payoff de la pauta/atención.
  const DIRECT_SRC = "('website','whatsapp_bot','whatsapp_transfer','manual')";
  const [mkContacts, mkWeb, mkSources, mkTopProps, mkDirectResv, mkDirectByProp, mkAirbnbStays, mkLeadsByAd] = await Promise.all([
    db.prepare(`SELECT COUNT(DISTINCT from_phone) AS c FROM whatsapp_messages WHERE direction='in' AND created_at >= ? AND created_at < ?`).bind(monthStartUtc, nextMonthStartUtc).first<{ c: number }>().catch(() => ({ c: 0 })),
    db.prepare(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS uniques FROM page_views WHERE created_at >= ? AND created_at < ?`).bind(monthStartUtc, nextMonthStartUtc).first<{ views: number; uniques: number }>().catch(() => ({ views: 0, uniques: 0 })),
    db.prepare(`SELECT COALESCE(NULLIF(utm_source,''), NULLIF(referrer,''), '(directo)') AS referrer, COUNT(*) AS c FROM page_views WHERE created_at >= ? AND created_at < ? GROUP BY 1 ORDER BY c DESC LIMIT 8`).bind(monthStartUtc, nextMonthStartUtc).all<{ referrer: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT path, COUNT(*) AS c FROM page_views WHERE path LIKE '/propiedades/%' AND created_at >= ? AND created_at < ? GROUP BY path ORDER BY c DESC LIMIT 8`).bind(monthStartUtc, nextMonthStartUtc).all<{ path: string; c: number }>().catch(() => ({ results: [] })),
    // Por CANAL, por CHECK-IN del mes (la estadía) — consistente con Ingresos y con
    // el conteo de Airbnb; así una reserva de junio cuenta en junio aunque se haya
    // cargado en julio (caso "Olvin").
    db.prepare(`SELECT source, SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed, COUNT(*) AS total FROM reservations WHERE source IN ${DIRECT_SRC} AND status IN ('pending','confirmed') AND check_in >= ? AND check_in < ? GROUP BY source ORDER BY total DESC`).bind(monthStart, nextMonthStart).all<{ source: string; confirmed: number; total: number }>().catch(() => ({ results: [] })),
    // Por PROPIEDAD (en qué propiedad se cerró cada reserva directa), por check-in.
    db.prepare(`SELECT property_slug AS slug, COUNT(*) AS total FROM reservations WHERE source IN ${DIRECT_SRC} AND status IN ('pending','confirmed') AND check_in >= ? AND check_in < ? GROUP BY property_slug ORDER BY total DESC`).bind(monthStart, nextMonthStart).all<{ slug: string; total: number }>().catch(() => ({ results: [] })),
    // Estadías de Airbnb con llegada en el mes (por check_in) — volumen del canal.
    db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE source IN ('airbnb','airbnb_ical') AND status IN ('pending','confirmed') AND check_in >= ? AND check_in < ?`).bind(monthStart, nextMonthStart).first<{ c: number }>().catch(() => ({ c: 0 })),
    // Leads de WhatsApp que vinieron de un ad (Click-to-WhatsApp), por anuncio.
    // Fail-soft si la tabla aún no existe. first_at = cuándo escribió por primera vez.
    db.prepare(`SELECT COALESCE(NULLIF(headline,''), NULLIF(source_url,''), source_id, 'Ad sin título') AS ad, COUNT(*) AS c FROM whatsapp_lead_source WHERE first_at >= ? AND first_at < ? GROUP BY ad ORDER BY c DESC LIMIT 10`).bind(monthStartUtc, nextMonthStartUtc).all<{ ad: string; c: number }>().catch(() => ({ results: [] })),
  ]);

  // ── Seguimiento POR PROPIEDAD (embudo) + desenlaces de conversación ───────────
  const [mkViewsByProp, mkAirbnbByProp, mkInquiriesByProp, mkOutcomes, mkWonBySource, mkWonByProp] = await Promise.all([
    // Vistas del sitio por propiedad (mes, por created_at del page_view).
    db.prepare(`SELECT path, COUNT(*) AS c FROM page_views WHERE path LIKE '/propiedades/%' AND created_at >= ? AND created_at < ? GROUP BY path`).bind(monthStartUtc, nextMonthStartUtc).all<{ path: string; c: number }>().catch(() => ({ results: [] })),
    // Reservas de Airbnb por propiedad (por check_in del mes).
    db.prepare(`SELECT property_slug AS slug, COUNT(*) AS c FROM reservations WHERE source IN ('airbnb','airbnb_ical') AND status IN ('pending','confirmed') AND check_in >= ? AND check_in < ? GROUP BY property_slug`).bind(monthStart, nextMonthStart).all<{ slug: string; c: number }>().catch(() => ({ results: [] })),
    // Consultas por WhatsApp por propiedad — bucketizadas por el PRIMER mensaje
    // entrante del lead (cuándo llegó), NO por updated_at del tag. Si no, el
    // auto-clasificador (que corre hoy) tiraría todo el histórico al mes actual.
    // COALESCE a updated_at conserva tags manuales de teléfonos sin inbound.
    db.prepare(`SELECT ct.property_slug AS slug, COUNT(*) AS c
      FROM conversation_tags ct
      LEFT JOIN (SELECT from_phone, MIN(created_at) AS first_at FROM whatsapp_messages WHERE direction='in' GROUP BY from_phone) fm ON fm.from_phone = ct.phone
      WHERE ct.property_slug IS NOT NULL AND ct.property_slug <> ''
        AND COALESCE(fm.first_at, ct.updated_at) >= ? AND COALESCE(fm.first_at, ct.updated_at) < ?
      GROUP BY ct.property_slug`).bind(monthStartUtc, nextMonthStartUtc).all<{ slug: string; c: number }>().catch(() => ({ results: [] })),
    // Desenlaces de conversación — mismo criterio: por el primer mensaje del lead.
    db.prepare(`SELECT ct.outcome AS outcome, COUNT(*) AS c
      FROM conversation_tags ct
      LEFT JOIN (SELECT from_phone, MIN(created_at) AS first_at FROM whatsapp_messages WHERE direction='in' GROUP BY from_phone) fm ON fm.from_phone = ct.phone
      WHERE ct.outcome IS NOT NULL
        AND COALESCE(fm.first_at, ct.updated_at) >= ? AND COALESCE(fm.first_at, ct.updated_at) < ?
      GROUP BY ct.outcome ORDER BY c DESC`).bind(monthStartUtc, nextMonthStartUtc).all<{ outcome: string; c: number }>().catch(() => ({ results: [] })),
    // CONSEGUIDAS este mes = por fecha de RESERVA (created_at). Efecto de la pauta:
    // cuándo entró la reserva (aunque la estadía sea otro mes). Solo directas.
    db.prepare(`SELECT source, COUNT(*) AS total FROM reservations WHERE source IN ${DIRECT_SRC} AND status IN ('pending','confirmed') AND created_at >= ? AND created_at < ? GROUP BY source ORDER BY total DESC`).bind(monthStartUtc, nextMonthStartUtc).all<{ source: string; total: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT property_slug AS slug, COUNT(*) AS total FROM reservations WHERE source IN ${DIRECT_SRC} AND status IN ('pending','confirmed') AND created_at >= ? AND created_at < ? GROUP BY property_slug ORDER BY total DESC`).bind(monthStartUtc, nextMonthStartUtc).all<{ slug: string; total: number }>().catch(() => ({ results: [] })),
  ]);

  // Salud del LLM del bot: último error registrado por el webhook cuando el bot
  // cae en bot_glitch_silent (Workers AI falló). Alimenta el semáforo rojo del Bot IA.
  const llmError = await db
    .prepare(`SELECT last_at AS t FROM system_heartbeat WHERE key='bot_llm_error'`)
    .first<{ t: string }>()
    .catch(() => ({ t: null }));

  // "Bot mudo": último latido del watchdog (cron/watchdog.ts) cuando detectó un
  // cliente con mensaje sin CUALQUIER respuesta hace >10 min. Mismo patrón que
  // bot_llm_error — alimenta el mismo semáforo rojo del Bot IA (pista B2).
  const botMudo = await db
    .prepare(`SELECT last_at AS t FROM system_heartbeat WHERE key='bot_mudo'`)
    .first<{ t: string }>()
    .catch(() => ({ t: null }));

  // ── 📬 SALUD DE ENTREGA WHATSAPP (qué mandó el bot, qué llegó, qué falló) ────
  // Fuentes: whatsapp_messages.status (checks del callback de Meta) + bot_trace
  // WA_DELIVERY_FAILED (motivo exacto, incluso para envíos sin fila propia) +
  // heartbeats owner_alert_ok/fail. Todo fail-soft. Índices en schema/0040.
  const [dlv7, dlv30, dlvFailedRows, dlvTraces, dlvStuck, dlvPendingCheckins, ownerAlertOk, ownerAlertFail] =
    await Promise.all([
      db.prepare(`SELECT COALESCE(status,'(sin)') AS status, COUNT(*) AS c FROM whatsapp_messages WHERE direction='out' AND created_at >= datetime('now','-7 days') GROUP BY status`).all<{ status: string; c: number }>().catch(() => ({ results: [] })),
      db.prepare(`SELECT COALESCE(status,'(sin)') AS status, COUNT(*) AS c FROM whatsapp_messages WHERE direction='out' AND created_at >= datetime('now','-30 days') GROUP BY status`).all<{ status: string; c: number }>().catch(() => ({ results: [] })),
      // Fallos con contexto (30d): quién, qué regla, cuándo. El motivo viene del merge con bot_trace.
      db.prepare(`SELECT meta_message_id, to_phone, matched_rule, body, created_at FROM whatsapp_messages WHERE direction='out' AND status='failed' AND created_at >= datetime('now','-30 days') ORDER BY created_at DESC LIMIT 20`).all<{ meta_message_id: string | null; to_phone: string; matched_rule: string | null; body: string | null; created_at: string }>().catch(() => ({ results: [] })),
      db.prepare(`SELECT at, phone, detail FROM bot_trace WHERE stage='WA_DELIVERY_FAILED' AND at >= datetime('now','-30 days') ORDER BY at DESC LIMIT 40`).all<{ at: string; phone: string; detail: string }>().catch(() => ({ results: [] })),
      // Atascados: Meta aceptó (sent) pero nunca reportó delivered en >24h — típico número muerto.
      db.prepare(`SELECT to_phone, matched_rule, created_at FROM whatsapp_messages WHERE direction='out' AND status='sent' AND created_at < datetime('now','-1 day') AND created_at >= datetime('now','-7 days') ORDER BY created_at DESC LIMIT 10`).all<{ to_phone: string; matched_rule: string | null; created_at: string }>().catch(() => ({ results: [] })),
      // "Qué está haciendo falta": check-ins de ayer→+2 días sin instrucciones enviadas o con error.
      db.prepare(`SELECT id, property_slug, guest_name, check_in, whatsapp_sent_at, whatsapp_error FROM reservations WHERE status = 'confirmed' AND check_in BETWEEN date('now','-1 day') AND date('now','+2 days') AND (whatsapp_sent_at IS NULL OR whatsapp_error IS NOT NULL) ORDER BY check_in ASC LIMIT 12`).all<{ id: number; property_slug: string; guest_name: string | null; check_in: string; whatsapp_sent_at: string | null; whatsapp_error: string | null }>().catch(() => ({ results: [] })),
      db.prepare(`SELECT last_at AS t FROM system_heartbeat WHERE key='owner_alert_ok'`).first<{ t: string }>().catch(() => ({ t: null })),
      db.prepare(`SELECT last_at AS t FROM system_heartbeat WHERE key='owner_alert_fail'`).first<{ t: string }>().catch(() => ({ t: null })),
    ]);

  // Merge fila↔trace por wamid: la fila da la regla/destino, el trace da el
  // código+motivo de Meta. Traces sin fila (ej. alertas a dueños) entran igual.
  const dlvAgg = (rows: { status: string; c: number }[]) => {
    const by: Record<string, number> = {};
    for (const r of rows) by[r.status] = r.c;
    const sent = Object.values(by).reduce((a, b) => a + b, 0);
    const known = (by["delivered"] ?? 0) + (by["read"] ?? 0) + (by["failed"] ?? 0) + (by["sent"] ?? 0);
    const arrived = (by["delivered"] ?? 0) + (by["read"] ?? 0);
    return {
      total: sent,
      deliveredPct: known > 0 ? Math.round((arrived / known) * 100) : null,
      readPct: known > 0 ? Math.round(((by["read"] ?? 0) / known) * 100) : null,
      failed: by["failed"] ?? 0,
      pending: (by["sent"] ?? 0) + (by["(sin)"] ?? 0),
    };
  };
  const traceByWamid = new Map<string, { at: string; phone: string; code: number | null; title: string }>();
  const tracesNoRow: { at: string; phone: string; code: number | null; title: string }[] = [];
  for (const t of rowsOf<{ at: string; phone: string; detail: string }>(dlvTraces)) {
    const p = parseWaFailTrace(t.detail);
    if (p.wamid) traceByWamid.set(p.wamid, { at: t.at, phone: t.phone, code: p.code, title: p.title });
    else tracesNoRow.push({ at: t.at, phone: t.phone, code: p.code, title: p.title });
  }
  const failedRowWamids = new Set<string>();
  const deliveryFailures = rowsOf<{ meta_message_id: string | null; to_phone: string; matched_rule: string | null; body: string | null; created_at: string }>(dlvFailedRows).map((f) => {
    if (f.meta_message_id) failedRowWamids.add(f.meta_message_id);
    const trace = f.meta_message_id ? traceByWamid.get(f.meta_message_id) : undefined;
    // Fallos síncronos (Meta rechazó el POST) llevan el error en el body [FAILED].
    const bodyErr = f.body?.includes("ERROR:") ? f.body.split("ERROR:").pop()?.trim().slice(0, 160) : null;
    return {
      at: f.created_at,
      to: f.to_phone,
      rule: f.matched_rule ?? "(sin regla)",
      code: trace?.code ?? null,
      reason: trace ? metaCodeLabel(trace.code) : (bodyErr || "Fallo de envío (ver chat)"),
    };
  });
  // Traces con wamid pero SIN fila failed en whatsapp_messages: envíos por fetch
  // directo sin fila propia (alertas a dueños, o templates de antes de wa-log).
  // También son fallos reales de entrega — que se vean.
  for (const [wamid, t] of traceByWamid) {
    if (!failedRowWamids.has(wamid)) tracesNoRow.push({ at: t.at, phone: t.phone, code: t.code, title: t.title });
  }
  tracesNoRow.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  const deliveryOrphanFailures = tracesNoRow.slice(0, 10).map((t) => ({
    at: t.at,
    to: t.phone,
    rule: "template_directo",
    code: t.code,
    reason: metaCodeLabel(t.code),
  }));

  // Airbnb health (cacheado 15 min por el fetch; no golpea Airbnb en cada poll)
  let airbnbStatus: "full" | "partial" | "unavailable" | "unknown" = "unknown";
  try {
    const blocked = await getBlockedDates("villa-b11-palma-real", env);
    if (blocked) airbnbStatus = blocked.airbnbSyncStatus;
  } catch {
    airbnbStatus = "unknown";
  }

  // ── Métricas por propiedad (ocupación + ingresos del mes calendario HN) ───────
  // Ocupación = noches ocupadas del mes ÷ días del mes, uniendo reservas directas
  // (D1, incluso las ya transcurridas) con el iCal de Airbnb. Ingresos = SUM(amount_usd)
  // de reservas cuya LLEGADA (check_in) cae en el mes.
  const propSlugs = Object.keys(SLUG_TO_SOURCES);

  // Noches directas (D1) que caen en el mes — incluye las ya transcurridas, que
  // getBlockedDates omite (filtra check_out >= hoy por ser para disponibilidad).
  const directRanges = await db
    .prepare(`SELECT property_slug AS slug, check_in, check_out FROM reservations WHERE status IN ('pending','confirmed') AND check_in < ? AND check_out > ?`)
    .bind(nextMonthStart, monthStart)
    .all<{ slug: string; check_in: string; check_out: string }>()
    .catch(() => ({ results: [] }));

  // El paquete "las-gemelas-tela" ocupa FÍSICAMENTE Casa Brisa + Casa Marea, pero
  // se guarda como una sola fila con ese slug. Repartimos sus noches a las dos casas
  // para que su ocupación NO se subestime (el ingreso sí queda una sola vez, en su fila).
  const GEMELAS_SLUG = "las-gemelas-tela";
  const GEMELAS_COMPONENTS = ["casa-brisa", "casa-marea"];
  const directNights: Record<string, Set<string>> = {};
  for (const r of rowsOf<{ slug: string; check_in: string; check_out: string }>(directRanges)) {
    const targets = r.slug === GEMELAS_SLUG ? GEMELAS_COMPONENTS : [r.slug];
    const nights: string[] = [];
    const cur = new Date(r.check_in + "T00:00:00Z");
    const end = new Date(r.check_out + "T00:00:00Z");
    while (cur < end) {
      const iso = cur.toISOString().slice(0, 10);
      if (iso >= monthStart && iso < nextMonthStart) nights.push(iso);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    for (const t of targets) {
      const set = (directNights[t] ??= new Set<string>());
      for (const iso of nights) set.add(iso);
    }
  }

  // Ocupación por propiedad: unión (Airbnb iCal ∪ D1) ∩ mes, deduplicada por fecha.
  const occByProperty: Record<string, { pct: number | null; nights: number; sync: string }> = {};
  await Promise.all(
    propSlugs.map(async (slug) => {
      const set = new Set<string>(directNights[slug] ?? []);
      let sync = "unavailable";
      try {
        const bd = await getBlockedDates(slug, env);
        if (bd) {
          sync = bd.airbnbSyncStatus;
          for (const d of bd.blocked) if (d >= monthStart && d < nextMonthStart) set.add(d);
        }
      } catch {
        /* fail-soft: ocupación solo con lo directo */
      }
      occByProperty[slug] = {
        nights: set.size,
        pct: daysInMonth > 0 ? Math.round((set.size / daysInMonth) * 100) : null,
        sync,
      };
    }),
  );

  // Ingresos + conteo por propiedad desde la query D1.
  const revBySlug = rowsOf<{ slug: string; revenue: number; revenueHnl: number; reservas: number; revNightsUsd: number }>(revByProperty);
  const revMap: Record<string, { revenue: number; revenueHnl: number; reservas: number; revNightsUsd: number }> = {};
  for (const r of revBySlug) revMap[r.slug] = { revenue: r.revenue, revenueHnl: r.revenueHnl, reservas: r.reservas, revNightsUsd: r.revNightsUsd };

  // ADR (Average Daily Rate) = ingreso USD ÷ noches que generaron ese USD. Es la
  // palanca de revenue management del canal Airbnb (98% del revenue): cruzarlo con
  // ocupación dice qué propiedad está subpreciada (rating+ocupación altos, ADR bajo)
  // vs con problema de producto. null si no hubo noches USD en el mes (evita /0).
  const adrOf = (slug: string): number | null => {
    const n = revMap[slug]?.revNightsUsd ?? 0;
    const rev = revMap[slug]?.revenue ?? 0;
    return n > 0 ? Math.round((rev / n) * 10) / 10 : null;
  };

  const porPropiedad = propSlugs.map((slug) => ({
    slug,
    revenueMonth: Math.round(revMap[slug]?.revenue ?? 0),
    revenueHnlMonth: Math.round(revMap[slug]?.revenueHnl ?? 0),
    reservasMonth: revMap[slug]?.reservas ?? 0,
    occupancyPct: occByProperty[slug]?.pct ?? null,
    nightsBooked: occByProperty[slug]?.nights ?? 0,
    adrUsd: adrOf(slug),
    airbnbSync: occByProperty[slug]?.sync ?? "unknown",
  }));
  // Slugs con ingreso que NO son de los 6 canónicos (p.ej. paquete gemelas): no esconder plata.
  for (const r of revBySlug) {
    if (!propSlugs.includes(r.slug)) {
      porPropiedad.push({ slug: r.slug, revenueMonth: Math.round(r.revenue), revenueHnlMonth: Math.round(r.revenueHnl), reservasMonth: r.reservas, occupancyPct: null, nightsBooked: 0, adrUsd: adrOf(r.slug), airbnbSync: "n/a" });
    }
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

  // Ingreso Airbnb cacheado → número por período, o null si no hay fila aún.
  const aiRows = rowsOf<{ period: string; amount_usd: number }>(airbnbIncome);
  const aiIncome = (p: string): number | null => {
    const r = aiRows.find((x) => x.period === p);
    return r ? Math.round(r.amount_usd) : null;
  };

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    messages: {
      todayIn: dir(msgsToday, "in"),
      todayOut: dir(msgsToday, "out"),
      weekIn: dir(msgsWeek, "in"),
      weekOut: dir(msgsWeek, "out"),
      today: numOf(msgRanges, "today"),
      week: numOf(msgRanges, "week"),
      month: numOf(msgRanges, "month"),
    },
    conversations: {
      today: numOf(convRanges, "today"),
      week: numOf(convRanges, "week"),
      month: numOf(convRanges, "month"),
    },
    funnel: {
      awaitingData: fc("awaiting_quote_data"),
      quoteProvided: fc("quote_provided"),
      awaitingPaymentMethod: fc("awaiting_payment_method"),
      awaitingPaypal: fc("awaiting_paypal_capture"),
      awaitingTransfer: fc("awaiting_transfer_proof"),
      total: funnel.reduce((s, r) => s + r.c, 0),
    },
    // Embudo de CONVERSIÓN de la cohorte de leads nuevos (30d) — pista del bot,
    // sesión B3. Distinto del `funnel` de arriba (que es una foto del estado ACTUAL
    // de conversation_state, no una cohorte). Línea base para medir el impacto de
    // las próximas sesiones (B4 followups, B5 botones, B6 audio, B7 post-checkout).
    conversionFunnel: {
      leadsNew: numOf(funnelRow, "leadsNew"),
      leadsQuoted: numOf(funnelRow, "leadsQuoted"),
      leadsQuotedPct: numOf(funnelRow, "leadsNew") > 0 ? Math.round((numOf(funnelRow, "leadsQuoted") / numOf(funnelRow, "leadsNew")) * 100) : 0,
      leadsPaid: numOf(funnelRow, "leadsPaid"),
      leadsPaidPct: numOf(funnelRow, "leadsNew") > 0 ? Math.round((numOf(funnelRow, "leadsPaid") / numOf(funnelRow, "leadsNew")) * 100) : 0,
      medianFirstResponseMin: medianFirstResponseMin === null ? null : Math.round(medianFirstResponseMin * 10) / 10,
      // "Efectividad" = sigue interesado (NO es la tasa de respuesta cruda — un
      // "gracias pero no tengo dinero" respondió, pero es un rechazo, no una
      // recuperación). Los otros dos buckets quedan visibles para no esconder nada.
      followupSent,
      followupStillInterested,
      followupDeclined,
      followupNoResponse,
      followupEffectivenessPct: followupSent > 0 ? Math.round((followupStillInterested / followupSent) * 100) : 0,
      revenueByOrigin: rowsOf<{ origin: string; revenue: number; reservas: number }>(revenueByOriginRows),
    },
    reservations: {
      today: numOf(resvCounts, "today"),
      week: numOf(resvCounts, "week"),
      month: numOf(resvCounts, "month"),
      byProperty: rowsOf<{ slug: string; c: number }>(resvByProperty),
      bySource: rowsOf<{ source: string; c: number }>(resvBySource),
    },
    revenue: {
      // Ingreso directo (reservas en D1: sitio + bot, pagadas/pendientes).
      direct: {
        today: Math.round(numOf(revRanges, "today")),
        week: Math.round(numOf(revRanges, "week")),
        month: Math.round(numOf(revRanges, "month")),
      },
      // Ingreso Airbnb (payouts vía PayPal Transaction Search, cacheado por cron).
      // null cuando aún no hay datos (cron no configurado / sin correr todavía).
      airbnb: {
        today: aiIncome("today"),
        week: aiIncome("week"),
        month: aiIncome("month"),
      },
    },
    // Ocupación + ingresos por propiedad del mes seleccionado (ver bloque arriba).
    porPropiedad,
    mes: { prefix: monthPrefix, dias: daysInMonth },
    // Ingreso del mes seleccionado, monedas SEPARADAS (nunca sumadas).
    revenueMonth: {
      usd: Math.round(numOf(revMonthRow, "usd")),
      hnl: Math.round(numOf(revMonthRow, "hnl")),
      usdAirbnb: Math.round(numOf(revMonthRow, "usdAirbnb")),
      usdDirect: Math.round(numOf(revMonthRow, "usd") - numOf(revMonthRow, "usdAirbnb")),
      reservas: numOf(revMonthRow, "reservas"),
    },
    // Meses con reservas (por check_in) para el selector; se asegura el actual.
    availableMonths: (() => {
      const list = rowsOf<{ m: string }>(availMonthsRows).map((r) => r.m).filter(Boolean);
      if (!list.includes(monthPrefix)) list.push(monthPrefix);
      return [...new Set(list)].sort().reverse();
    })(),
    // Reporte para marketing/pauta (mes seleccionado).
    marketing: {
      contacts: numOf(mkContacts, "c"),
      webViews: numOf(mkWeb, "views"),
      webUniques: numOf(mkWeb, "uniques"),
      sources: rowsOf<{ referrer: string; c: number }>(mkSources),
      topProperties: rowsOf<{ path: string; c: number }>(mkTopProps),
      // ESTADÍAS del mes (por check-in): cuándo LLEGA el huésped (operación).
      directBySource: rowsOf<{ source: string; confirmed: number; total: number }>(mkDirectResv),
      directByProperty: rowsOf<{ slug: string; total: number }>(mkDirectByProp),
      airbnbStays: numOf(mkAirbnbStays, "c"),
      // CONSEGUIDAS del mes (por fecha de reserva): cuándo se RESERVÓ (efecto pauta).
      wonBySource: rowsOf<{ source: string; total: number }>(mkWonBySource),
      wonByProperty: rowsOf<{ slug: string; total: number }>(mkWonByProp),
      // Leads de WhatsApp que vinieron de un ad Click-to-WhatsApp (por anuncio).
      leadsByAd: rowsOf<{ ad: string; c: number }>(mkLeadsByAd),
      // Embudo POR PROPIEDAD: vistas web → consultas WhatsApp → reservas (Airbnb / directas).
      funnelByProperty: (() => {
        const viewMap: Record<string, number> = {};
        for (const r of rowsOf<{ path: string; c: number }>(mkViewsByProp)) {
          const s = r.path.replace("/propiedades/", "");
          viewMap[s] = (viewMap[s] ?? 0) + r.c;
        }
        const airbnbMap: Record<string, number> = {};
        for (const r of rowsOf<{ slug: string; c: number }>(mkAirbnbByProp)) airbnbMap[r.slug] = r.c;
        const inqMap: Record<string, number> = {};
        for (const r of rowsOf<{ slug: string; c: number }>(mkInquiriesByProp)) inqMap[r.slug] = r.c;
        const dirMap: Record<string, number> = {};
        for (const r of rowsOf<{ slug: string; total: number }>(mkDirectByProp)) dirMap[r.slug] = r.total;
        const allSlugs = new Set<string>([...propSlugs, ...Object.keys(viewMap), ...Object.keys(airbnbMap), ...Object.keys(inqMap), ...Object.keys(dirMap)]);
        return [...allSlugs]
          .map((slug) => ({
            slug,
            webViews: viewMap[slug] ?? 0,
            waInquiries: inqMap[slug] ?? 0,
            resAirbnb: airbnbMap[slug] ?? 0,
            resDirect: dirMap[slug] ?? 0,
          }))
          .filter((f) => f.webViews || f.waInquiries || f.resAirbnb || f.resDirect)
          .sort((a, b) => (b.resAirbnb + b.resDirect) * 100 + b.webViews - ((a.resAirbnb + a.resDirect) * 100 + a.webViews));
      })(),
      // Desenlaces de las conversaciones etiquetadas este mes.
      outcomes: rowsOf<{ outcome: string; c: number }>(mkOutcomes),
    },
    health: {
      lastInAt: strOf(lastIn, "t"),
      lastOutAt: strOf(lastOut, "t"),
      lastReservationAt: strOf(lastResv, "t"),
      cronLastAt: strOf(heartbeat, "t"),
      airbnbStatus,
      botLlmErrorAt: strOf(llmError, "t"),
      botMudoAt: strOf(botMudo, "t"),
      // Semáforos de entrega (📬): fallos 24h + estado del canal de avisos a dueños.
      waFailed24h:
        deliveryFailures.filter((f) => f.at >= new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ")).length +
        deliveryOrphanFailures.filter((f) => f.at && f.at >= new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ")).length,
      ownerAlertOkAt: strOf(ownerAlertOk, "t"),
      ownerAlertFailAt: strOf(ownerAlertFail, "t"),
    },
    // 📬 Salud de entrega WhatsApp: qué mandó el bot, qué llegó y qué falta.
    delivery: {
      d7: dlvAgg(rowsOf<{ status: string; c: number }>(dlv7)),
      d30: dlvAgg(rowsOf<{ status: string; c: number }>(dlv30)),
      failures: [...deliveryFailures, ...deliveryOrphanFailures]
        .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
        .slice(0, 20),
      stuck: rowsOf<{ to_phone: string; matched_rule: string | null; created_at: string }>(dlvStuck).map((s) => ({
        at: s.created_at,
        to: s.to_phone,
        rule: s.matched_rule ?? "(sin regla)",
      })),
      pendingCheckins: rowsOf<{ id: number; property_slug: string; guest_name: string | null; check_in: string; whatsapp_sent_at: string | null; whatsapp_error: string | null }>(dlvPendingCheckins).map((r) => ({
        id: r.id,
        property: r.property_slug,
        guest: r.guest_name ?? "Huésped",
        checkIn: r.check_in,
        state: r.whatsapp_error ? ("fallo" as const) : ("sin_enviar" as const),
        error: r.whatsapp_error ? r.whatsapp_error.slice(0, 160) : null,
      })),
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
    web: {
      viewsToday: numOf(webToday, "views"),
      uniqueToday: numOf(webToday, "uniques"),
      viewsYesterday: numOf(webYesterday, "views"),
      viewsWeek: numOf(webWeek, "views"),
      uniqueWeek: numOf(webWeek, "uniques"),
      now: numOf(webNow, "c"),
      topPages: rowsOf<{ path: string; c: number }>(webTopPages),
      sources: rowsOf<{ referrer: string; c: number }>(webSources),
      trend: rowsOf<{ day: string; views: number; uniques: number }>(webTrend),
    },
    qa: {
      lastRun: qaLastRun
        ? { ranAt: strOf(qaLastRun, "ran_at"), analyzed: numOf(qaLastRun, "analyzed"), found: numOf(qaLastRun, "found"), trigger: strOf(qaLastRun, "trigger") }
        : null,
      findings: rowsOf<{ id: number; phone: string; issue: string; severity: string; detail: string; suggestion: string; conv_at: string }>(qaFindings),
    },
    // Dónde falla el bot, agrupado (error analysis) → arreglar la categoría más
    // grande primero. byIssue = snapshot del QA; byStage/byRule = últimos 7 días.
    failures: {
      byIssue: rowsOf<{ issue: string; c: number; alta: number }>(failuresByIssue),
      byStage: rowsOf<{ stage: string; c: number }>(traceByStage),
      byRule: rowsOf<{ rule: string; c: number }>(escalationsByRule),
      escalationPct,
    },
  });
};
