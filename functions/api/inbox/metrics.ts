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
    db.prepare(`SELECT property_slug AS slug, COALESCE(SUM(amount_usd),0) AS revenue, COALESCE(SUM(total_hnl),0) AS revenueHnl, COUNT(*) AS reservas FROM reservations WHERE status IN ('pending','confirmed') AND check_in >= ? AND check_in < ? GROUP BY property_slug`).bind(monthStart, nextMonthStart).all<{ slug: string; revenue: number; revenueHnl: number; reservas: number }>().catch(() => ({ results: [] })),
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
  const [mkContacts, mkWeb, mkSources, mkTopProps, mkDirectResv, mkDirectByProp, mkAirbnbStays] = await Promise.all([
    db.prepare(`SELECT COUNT(DISTINCT from_phone) AS c FROM whatsapp_messages WHERE direction='in' AND created_at >= ? AND created_at < ?`).bind(monthStartUtc, nextMonthStartUtc).first<{ c: number }>().catch(() => ({ c: 0 })),
    db.prepare(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS uniques FROM page_views WHERE created_at >= ? AND created_at < ?`).bind(monthStartUtc, nextMonthStartUtc).first<{ views: number; uniques: number }>().catch(() => ({ views: 0, uniques: 0 })),
    db.prepare(`SELECT COALESCE(NULLIF(utm_source,''), NULLIF(referrer,''), '(directo)') AS referrer, COUNT(*) AS c FROM page_views WHERE created_at >= ? AND created_at < ? GROUP BY 1 ORDER BY c DESC LIMIT 8`).bind(monthStartUtc, nextMonthStartUtc).all<{ referrer: string; c: number }>().catch(() => ({ results: [] })),
    db.prepare(`SELECT path, COUNT(*) AS c FROM page_views WHERE path LIKE '/propiedades/%' AND created_at >= ? AND created_at < ? GROUP BY path ORDER BY c DESC LIMIT 8`).bind(monthStartUtc, nextMonthStartUtc).all<{ path: string; c: number }>().catch(() => ({ results: [] })),
    // Por CANAL, por fecha de RESERVA (created_at). Airbnb va aparte (su created_at es del backfill).
    db.prepare(`SELECT source, SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed, COUNT(*) AS total FROM reservations WHERE source IN ${DIRECT_SRC} AND status IN ('pending','confirmed') AND created_at >= ? AND created_at < ? GROUP BY source ORDER BY total DESC`).bind(monthStartUtc, nextMonthStartUtc).all<{ source: string; confirmed: number; total: number }>().catch(() => ({ results: [] })),
    // Por PROPIEDAD (en qué propiedad se cerró cada reserva directa).
    db.prepare(`SELECT property_slug AS slug, COUNT(*) AS total FROM reservations WHERE source IN ${DIRECT_SRC} AND status IN ('pending','confirmed') AND created_at >= ? AND created_at < ? GROUP BY property_slug ORDER BY total DESC`).bind(monthStartUtc, nextMonthStartUtc).all<{ slug: string; total: number }>().catch(() => ({ results: [] })),
    // Estadías de Airbnb con llegada en el mes (por check_in) — volumen del canal.
    db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE source IN ('airbnb','airbnb_ical') AND status IN ('pending','confirmed') AND check_in >= ? AND check_in < ?`).bind(monthStart, nextMonthStart).first<{ c: number }>().catch(() => ({ c: 0 })),
  ]);

  // Salud del LLM del bot: último error registrado por el webhook cuando el bot
  // cae en bot_glitch_silent (Workers AI falló). Alimenta el semáforo rojo del Bot IA.
  const llmError = await db
    .prepare(`SELECT last_at AS t FROM system_heartbeat WHERE key='bot_llm_error'`)
    .first<{ t: string }>()
    .catch(() => ({ t: null }));

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
  const revBySlug = rowsOf<{ slug: string; revenue: number; revenueHnl: number; reservas: number }>(revByProperty);
  const revMap: Record<string, { revenue: number; revenueHnl: number; reservas: number }> = {};
  for (const r of revBySlug) revMap[r.slug] = { revenue: r.revenue, revenueHnl: r.revenueHnl, reservas: r.reservas };

  const porPropiedad = propSlugs.map((slug) => ({
    slug,
    revenueMonth: Math.round(revMap[slug]?.revenue ?? 0),
    revenueHnlMonth: Math.round(revMap[slug]?.revenueHnl ?? 0),
    reservasMonth: revMap[slug]?.reservas ?? 0,
    occupancyPct: occByProperty[slug]?.pct ?? null,
    nightsBooked: occByProperty[slug]?.nights ?? 0,
    airbnbSync: occByProperty[slug]?.sync ?? "unknown",
  }));
  // Slugs con ingreso que NO son de los 6 canónicos (p.ej. paquete gemelas): no esconder plata.
  for (const r of revBySlug) {
    if (!propSlugs.includes(r.slug)) {
      porPropiedad.push({ slug: r.slug, revenueMonth: Math.round(r.revenue), revenueHnlMonth: Math.round(r.revenueHnl), reservasMonth: r.reservas, occupancyPct: null, nightsBooked: 0, airbnbSync: "n/a" });
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
      // Conversiones directas por fecha de reserva (pauta) + volumen Airbnb (check-in).
      directBySource: rowsOf<{ source: string; confirmed: number; total: number }>(mkDirectResv),
      directByProperty: rowsOf<{ slug: string; total: number }>(mkDirectByProp),
      airbnbStays: numOf(mkAirbnbStays, "c"),
    },
    health: {
      lastInAt: strOf(lastIn, "t"),
      lastOutAt: strOf(lastOut, "t"),
      lastReservationAt: strOf(lastResv, "t"),
      cronLastAt: strOf(heartbeat, "t"),
      airbnbStatus,
      botLlmErrorAt: strOf(llmError, "t"),
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
