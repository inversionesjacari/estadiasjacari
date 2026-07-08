/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/watchdog
//
// Vigila que los OTROS crons sigan corriendo. Se dispara desde
// scripts/cron-worker.js cada 30 min. Tres chequeos:
//   1. Staleness por cron_key: ¿corrió hace más de lo esperado + holgura? (system_heartbeat)
//   2. Racha de fallos por cron_key: ¿las últimas 3 corridas fallaron? (cron_runs)
//   3. "Bot mudo": ¿hay un cliente con un mensaje SIN responder hace rato? (whatsapp_messages)
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
import { TERMINAL_RULES } from "../../_lib/detectors";
import { lastRealOutRule } from "./quote-followups";

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

  const botMudo = await checkBotMudo(env);
  if (botMudo.phones.length > 0) {
    findings.push({ key: "bot_mudo", issue: `${botMudo.phones.length} cliente(s) sin respuesta`, alerted: botMudo.alerted });
  }

  return json({ ok: true, checked: Object.keys(EXPECTED_SCHEDULE), findings, botMudo: botMudo.phones });
};

// Ventana de detección: un "in" de más de 10 min (holgura sobre bot-retry, que
// reintenta ~12 min antes de escalar) y menos de 24h (más viejo que eso, la
// ventana de Meta para texto libre ya cerró — es un lead frío, no una falla en
// curso) sin ningún "out" a partir de su hora, y sin estar pausado a mano.
const MUDO_MIN_AGE_MIN = 10;
const MUDO_MAX_AGE_HOURS = 24;

/**
 * "Bot mudo": cliente con un mensaje sin CUALQUIER respuesta del bot (ni humana
 * desde el inbox) hace más de MUDO_MIN_AGE_MIN. Es el patrón ⭐⭐ más caro del
 * historial (2026-06-09: un día entero de leads perdidos sin que nadie lo notara
 * hasta revisar el inbox a mano). Excluye:
 *   - reacciones (emoji sobre un mensaje nuestro — se guardan como 'in' pero
 *     NUNCA generan respuesta, por diseño; ver handleReaction en el webhook).
 *   - números con el bot pausado (un humano ya está atendiendo a mano).
 *   - conversaciones ya CERRADAS a propósito (última regla real del bot en
 *     TERMINAL_RULES, ej. 'farewell' → el siguiente "ok" del cliente se silencia
 *     intencionalmente — closing_ack_silent — y NUNCA debe leerse como bot mudo).
 */
async function checkBotMudo(env: Env): Promise<{ phones: string[]; alerted: boolean }> {
  try {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT m.from_phone AS phone
         FROM whatsapp_messages m
        WHERE m.direction = 'in'
          AND m.created_at <= datetime('now', ?)
          AND m.created_at >= datetime('now', ?)
          AND m.body NOT LIKE 'Reaccionó con%'
          AND m.body <> 'Quitó su reacción'
          AND m.from_phone NOT IN (SELECT phone FROM bot_pauses)
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_messages o
             WHERE o.direction = 'out' AND o.to_phone = m.from_phone AND o.created_at >= m.created_at
          )
        LIMIT 10`,
    )
      .bind(`-${MUDO_MIN_AGE_MIN} minutes`, `-${MUDO_MAX_AGE_HOURS} hours`)
      .all<{ phone: string }>();

    const candidates = (rows.results ?? []).map((r) => r.phone);
    const phones: string[] = [];
    for (const phone of candidates) {
      const lastRule = await lastRealOutRule(phone, env.DB);
      if (lastRule && TERMINAL_RULES.has(lastRule)) continue; // silencio intencional, no es falla
      phones.push(phone);
    }

    if (phones.length === 0) return { phones: [], alerted: false };

    // Latido → semáforo rojo del Bot IA en /inbox/operacion (mismo patrón que bot_llm_error).
    await env.DB.prepare(
      `INSERT INTO system_heartbeat (key, last_at) VALUES ('bot_mudo', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
    ).run();

    const alerted = await maybeAlert(
      env,
      "bot_mudo",
      "🔴 Bot sin responder",
      "bot_mudo",
      `${phones.length} cliente(s) con mensaje sin respuesta hace más de ${MUDO_MIN_AGE_MIN} min: ${phones.slice(0, 3).join(", ")}${phones.length > 3 ? "…" : ""}. Revisá el inbox.`,
    );
    return { phones, alerted };
  } catch (err) {
    console.error("checkBotMudo error:", (err as Error).message);
    return { phones: [], alerted: false };
  }
}

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
