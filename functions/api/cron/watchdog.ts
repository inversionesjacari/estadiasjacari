/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/watchdog
//
// Vigila que los OTROS crons sigan corriendo. Se dispara desde
// scripts/cron-worker.js cada 30 min. Dos chequeos, por cron_key:
//   1. Staleness: ¿corrió hace más de lo esperado + holgura? (system_heartbeat)
//   2. Racha de fallos: ¿las últimas 3 corridas fallaron? (cron_runs)
// Si algo dispara, avisa por WhatsApp a César/socio (con cooldown de 6h por
// alerta — el mismo mecanismo de heartbeat, con una key `watchdog_alert_*`,
// para no mandar el mismo aviso cada 30 min mientras el problema siga vivo).
//
// Auth: Authorization: Bearer <CRON_SECRET>. Responde SIEMPRE 200 con detalle.
//
// `cron_whatsapp_operations` NO está en el mapa: sigue desactivado (falta
// cargar property_contacts, ver cron-worker.js) — vigilarlo generaría una
// alerta falsa de "nunca corrió". Agregarlo acá cuando se active.

import { requireBearerAuth } from "../../_lib/admin-auth";
import { notifyOwners, type OwnerAlertEnv } from "../../_lib/owner-alerts";

interface Env extends OwnerAlertEnv {
  DB: D1Database;
  CRON_SECRET?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Cada cuántos minutos se espera que corra + holgura extra antes de avisar
// (generosa a propósito: evita falsos positivos por un deploy o un reintento).
const EXPECTED_SCHEDULE: Record<string, { everyMin: number; graceMin: number }> = {
  cron_bot_retry: { everyMin: 2, graceMin: 15 },
  cron_followups: { everyMin: 10, graceMin: 30 },
  cron_paypal_income: { everyMin: 60, graceMin: 180 },
  cron_checkin_reminders: { everyMin: 1440, graceMin: 120 }, // 1x/día + 2h de holgura
};

const ALERT_COOLDOWN_HOURS = 6;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  const findings: Array<{ key: string; issue: string; alerted: boolean }> = [];

  for (const [key, sched] of Object.entries(EXPECTED_SCHEDULE)) {
    try {
      const staleLimit = sched.everyMin + sched.graceMin;
      const recent = await env.DB.prepare(
        `SELECT 1 AS x FROM system_heartbeat WHERE key = ? AND last_at > datetime('now', ?)`,
      )
        .bind(key, `-${staleLimit} minutes`)
        .first<{ x: number }>();

      if (!recent) {
        const alerted = await maybeAlert(
          env,
          `${key}_stale`,
          "🔴 Cron sin correr",
          key,
          `${key} lleva más de ${staleLimit} min sin correr (se esperaba cada ${sched.everyMin} min).`,
        );
        findings.push({ key, issue: "stale", alerted });
      }

      const last3 = await env.DB.prepare(
        `SELECT ok FROM cron_runs WHERE cron_key = ? ORDER BY started_at DESC LIMIT 3`,
      )
        .bind(key)
        .all<{ ok: number }>();
      const rows = last3.results ?? [];
      if (rows.length === 3 && rows.every((r) => r.ok === 0)) {
        const alerted = await maybeAlert(
          env,
          `${key}_failing`,
          "🔴 Cron fallando seguido",
          key,
          `Las últimas 3 corridas de ${key} fallaron. Revisar logs.`,
        );
        findings.push({ key, issue: "failing_streak", alerted });
      }
    } catch (err) {
      findings.push({ key, issue: `watchdog_error: ${(err as Error).message}`, alerted: false });
    }
  }

  return json({ ok: true, checked: Object.keys(EXPECTED_SCHEDULE), findings });
};

/** Avisa por WhatsApp si no se avisó lo mismo en las últimas ALERT_COOLDOWN_HOURS. */
async function maybeAlert(
  env: Env,
  cooldownKey: string,
  tipo: string,
  cronKey: string,
  detalle: string,
): Promise<boolean> {
  const alertKey = `watchdog_alert_${cooldownKey}`;
  const recent = await env.DB.prepare(
    `SELECT 1 AS x FROM system_heartbeat WHERE key = ? AND last_at > datetime('now', ?)`,
  )
    .bind(alertKey, `-${ALERT_COOLDOWN_HOURS} hours`)
    .first<{ x: number }>();
  if (recent) return false; // ya se avisó recientemente, no repetir

  await notifyOwners(env, { tipo, cliente: cronKey, detalle, guestPhone: "" });
  await env.DB.prepare(
    `INSERT INTO system_heartbeat (key, last_at) VALUES (?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
  )
    .bind(alertKey)
    .run();
  return true;
}
