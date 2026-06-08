/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/paypal-income
//
// Lee los payouts de Airbnb de las cuentas PayPal configuradas (Transaction
// Search API), los suma por rango (hoy / 7 días / 30 días) y los cachea en la
// tabla `airbnb_income`. El endpoint de métricas del dashboard lee esa caché
// (rápido), en vez de pegarle a PayPal en cada poll de 10 s.
//
// Disparado por el Worker `estadia-jacari-cron` (sugerido: cada hora).
// Auth: Authorization: Bearer <CRON_SECRET>.
//
// Debug: `?debug=1` devuelve las transacciones encontradas SIN escribir en D1
// (para verificar que el filtro "Airbnb" matchea bien antes de confiar en los
// totales). Respuesta SIEMPRE 200 con detalle JSON.
//

import { requireBearerAuth } from "../../_lib/admin-auth";
import { fetchAirbnbTxns, configuredAccounts, type AirbnbTxn } from "../../_lib/paypal-reporting";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_CACEJAU_CLIENT_ID?: string;
  PAYPAL_CACEJAU_CLIENT_SECRET?: string;
  PAYPAL_JACARI_CLIENT_ID?: string;
  PAYPAL_JACARI_CLIENT_SECRET?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Inicio del día de hoy en Honduras (UTC-6), en ms UTC. */
function hnDayStartMs(now: number): number {
  const shifted = new Date(now - 6 * 3600 * 1000); // a hora-pared HN
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) + 6 * 3600 * 1000;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  const debug = new URL(request.url).searchParams.get("debug") === "1";
  const apiBase = env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  const accounts = configuredAccounts(env as unknown as Record<string, string | undefined>);
  if (accounts.length === 0) {
    return json({ ok: false, error: "Sin cuentas PayPal configuradas (faltan PAYPAL_CACEJAU_CLIENT_ID/SECRET y/o PAYPAL_CLIENT_ID/SECRET)" });
  }

  const now = Date.now();
  // Rango de búsqueda: últimos 30 días (cubre la ventana de 30d del dashboard y
  // queda bajo el límite de 31 días por llamada de la API).
  const endIso = new Date(now).toISOString();
  const startIso = new Date(now - 30 * 86400 * 1000).toISOString();

  const all: AirbnbTxn[] = [];
  const errors: string[] = [];
  for (const acct of accounts) {
    const { txns, error } = await fetchAirbnbTxns(apiBase, acct, startIso, endIso);
    if (error) errors.push(error);
    all.push(...txns);
  }

  // Sumar por rango (cumulativo: month ⊇ week ⊇ today, igual que las cards).
  const todayStart = hnDayStartMs(now);
  const weekStart = now - 7 * 86400 * 1000;
  const monthStart = now - 30 * 86400 * 1000;
  const sums = { today: 0, week: 0, month: 0 };
  const counts = { today: 0, week: 0, month: 0 };
  for (const t of all) {
    const ts = Date.parse(t.date);
    if (Number.isNaN(ts)) continue;
    if (ts >= monthStart) { sums.month += t.amount; counts.month++; }
    if (ts >= weekStart) { sums.week += t.amount; counts.week++; }
    if (ts >= todayStart) { sums.today += t.amount; counts.today++; }
  }

  if (debug) {
    return json({
      ok: true, debug: true, range: { startIso, endIso },
      accounts: accounts.map((a) => a.label), errors,
      matched: all.length, sums, counts,
      sample: all.slice(0, 25),
    });
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  try {
    const stmt = env.DB.prepare(
      `INSERT INTO airbnb_income (period, amount_usd, tx_count, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(period) DO UPDATE SET
         amount_usd = excluded.amount_usd,
         tx_count   = excluded.tx_count,
         updated_at = excluded.updated_at`,
    );
    await env.DB.batch([
      stmt.bind("today", round(sums.today), counts.today),
      stmt.bind("week", round(sums.week), counts.week),
      stmt.bind("month", round(sums.month), counts.month),
    ]);
  } catch (err) {
    return json({ ok: false, error: `D1 upsert: ${(err as Error).message}`, sums });
  }

  return json({ ok: errors.length === 0, errors, sums, counts, accounts: accounts.map((a) => a.label) });
};
