/// <reference types="@cloudflare/workers-types" />
//
// POST /api/cron/watchdog
//
// Vigila que los OTROS crons sigan corriendo. Se dispara desde
// scripts/cron-worker.js cada 30 min. Chequeos:
//   1. Staleness por cron_key: ¿corrió hace más de lo esperado + holgura? (system_heartbeat)
//   2. Racha de fallos por cron_key: ¿las últimas 3 corridas fallaron? (cron_runs)
//   3. "Bot mudo": ¿hay un cliente con un mensaje SIN responder hace rato? (whatsapp_messages)
//   4. KB en fallback hardcode (latido de kb-store.ts).
//   5. 📬 Salud de entrega: mensajes operativos al huésped que FALLARON (P1,
//      alerta siempre), ráfaga sistémica de fallos (P2) y canal de avisos a
//      dueños caído (P3). Los fallos sueltos de re-engagement (ventana 24h
//      cerrada etc.) NO alertan — se ven en la card del inbox.
// Si algo dispara, avisa por WhatsApp a César/socio (con cooldown de 6h por
// alerta — el mismo mecanismo de heartbeat, con una key `watchdog_alert_*`,
// para no mandar el mismo aviso cada 30 min mientras el problema siga vivo).
//
// Auth: Authorization: Bearer <CRON_SECRET>. Responde SIEMPRE 200 con detalle.
//
// Los 4 hitos de `cron_whatsapp_operations` están en el mapa con
// `skipIfNeverRan`: hasta que corran por PRIMERA vez (requiere que César
// re-pegue el cron-worker en el dashboard) no generan la alerta falsa de
// "nunca corrió"; una vez que laten, se vigilan como cualquier otro cron.

import { requireBearerAuth } from "../../_lib/admin-auth";
import { notifyOwners, type OwnerAlertEnv } from "../../_lib/owner-alerts";
import { TERMINAL_RULES } from "../../_lib/detectors";
import { lastRealOutRule } from "./quote-followups";
import { globalBotPausedSince } from "../../_lib/bot-pause";
import { GUEST_OPERATIONAL_RULES } from "../../_lib/wa-log";

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
// `skipIfNeverRan`: no alertar si el cron no tiene NI UN latido — cubre a los
// hitos que viven en el cron-worker (pegado a mano) y aún no se activaron.
const EXPECTED_SCHEDULE: Record<
  string,
  { everyMin: number; graceMin: number; skipIfNeverRan?: boolean }
> = {
  cron_bot_retry: { everyMin: 2, graceMin: 15 },
  cron_followups: { everyMin: 10, graceMin: 30 },
  cron_paypal_income: { everyMin: 60, graceMin: 180 },
  cron_checkin_reminders: { everyMin: 1440, graceMin: 120 }, // 1x/día + 2h de holgura
  // Avisos operativos (RECORDATORIOS-0712): 1x/día cada hito + 2h de holgura.
  "cron_whatsapp_operations_evening-staff": { everyMin: 1440, graceMin: 120, skipIfNeverRan: true },
  "cron_whatsapp_operations_morning-staff": { everyMin: 1440, graceMin: 120, skipIfNeverRan: true },
  "cron_whatsapp_operations_morning-guests": { everyMin: 1440, graceMin: 120, skipIfNeverRan: true },
  "cron_whatsapp_operations_checkout-cleaning": { everyMin: 1440, graceMin: 120, skipIfNeverRan: true },
};

const ALERT_COOLDOWN_HOURS = 6;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  const findings: Array<{ key: string; issue: string; alerted: boolean }> = [];

  for (const [key, sched] of Object.entries(EXPECTED_SCHEDULE)) {
    try {
      const staleLimit = sched.everyMin + sched.graceMin;
      const hb = await env.DB.prepare(
        `SELECT (last_at > datetime('now', ?)) AS fresh FROM system_heartbeat WHERE key = ?`,
      )
        .bind(`-${staleLimit} minutes`, key)
        .first<{ fresh: number }>();

      if (!hb && sched.skipIfNeverRan) {
        // Nunca corrió y el hito vive en el cron-worker pegado a mano: todavía
        // no hay nada que vigilar (se anota, sin alertar).
        findings.push({ key, issue: "never_ran (hito aún no activado en el Worker)", alerted: false });
      } else if (!hb || hb.fresh !== 1) {
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

  const kbFallback = await checkKbFallback(env);
  if (kbFallback.active) {
    findings.push({ key: "kb_fallback_hardcode", issue: "KB en modo hardcode", alerted: kbFallback.alerted });
  }

  const delivery = await checkDeliveryHealth(env);
  if (delivery.issues.length > 0) {
    findings.push({ key: "delivery", issue: delivery.issues.join(" · "), alerted: delivery.alerted });
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
    // Interruptor GENERAL apagado → el silencio es INTENCIONAL (César atendiendo a
    // mano por las ads). No gritar "bot mudo" mientras el apagado esté puesto.
    if (await globalBotPausedSince(env.DB)) {
      return { phones: [], alerted: false };
    }
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

// Ventana de detección del fallback de la KB: el latido `kb_fallback_hardcode`
// lo escribe kb-store.ts cada vez que una lectura cae al hardcode (kb_properties
// vacía o query fallida) o el panel queda sin propiedades ACTIVAS. Si hubo un
// latido en la última hora, el panel /inbox/conocimiento está siendo IGNORADO
// por el bot — precios/reglas/FAQs editados ahí no aplican. Un latido puntual
// puede ser un hiccup transitorio de D1; si el problema es real (migración sin
// aplicar), el latido se repite con cada mensaje y la alerta vuelve tras el
// cooldown hasta que alguien lo arregle.
const KB_FALLBACK_WINDOW_MIN = 60;

/** ¿La KB cayó al hardcode hace poco? (latido de kb-store.ts) */
async function checkKbFallback(env: Env): Promise<{ active: boolean; alerted: boolean }> {
  try {
    const recent = await env.DB.prepare(
      `SELECT 1 AS x FROM system_heartbeat WHERE key = 'kb_fallback_hardcode' AND last_at > datetime('now', ?)`,
    )
      .bind(`-${KB_FALLBACK_WINDOW_MIN} minutes`)
      .first<{ x: number }>();
    if (!recent) return { active: false, alerted: false };

    // ⚠️ máx 250 chars: buildAlertComponents trunca el {{3}} del template ahí —
    // más largo y Meta entrega la instrucción cortada a la mitad.
    const alerted = await maybeAlert(
      env,
      "kb_fallback",
      "🟠 KB en modo hardcode",
      "kb_fallback_hardcode",
      `El bot ignora el panel /inbox/conocimiento (kb_properties vacía, todas inactivas o error de D1): precios/reglas/FAQs del panel NO aplican. Si fue puntual, ignorá; si se repite, revisar schema/0011+0012 en D1.`,
    );
    return { active: true, alerted };
  } catch (err) {
    console.error("checkKbFallback error:", (err as Error).message);
    return { active: false, alerted: false };
  }
}

// ── 📬 Salud de entrega (check 5) ─────────────────────────────────────────────
// Política anti-ruido (regla de la casa: no sobre-notificar):
//   P1 — operativo a HUÉSPED fallido (check-in PDF, confirmación, avisos del día)
//        → alerta SIEMPRE, dedupe por teléfono (el huésped se quedó sin info
//        crítica; hay que contactarlo por otro canal).
//   P2 — ráfaga: ≥DELIVERY_BURST_N fallos (cualquier regla) en la ventana
//        → problema sistémico (billing/template/Meta), una sola alerta.
//   P3 — canal de avisos a dueños caído (owner_alert_fail > owner_alert_ok)
//        → best-effort: si el canal está caído esta alerta puede no llegar;
//        el semáforo "Avisos a dueños" del inbox es la superficie garantizada.
//   Fallos sueltos de re-engagement (auto_followup/last_call, típico 131047
//   ventana cerrada) NO alertan solos — se ven en la card y cuentan para P2.
// Lookback de P1 (6h) > período del watchdog (30 min) a propósito: una corrida
// perdida no traga el fallo; el dedupe por teléfono hace inocuo el re-chequeo.
const DELIVERY_GUEST_LOOKBACK_HOURS = 6;
const DELIVERY_BURST_N = 3;
const DELIVERY_BURST_WINDOW_MIN = 60;
const DELIVERY_GUEST_MAX_ALERTS = 3; // por corrida — no inundar si fallan muchos a la vez (eso ya es P2)

async function checkDeliveryHealth(env: Env): Promise<{ issues: string[]; alerted: boolean }> {
  const issues: string[] = [];
  let alertedAny = false;
  try {
    // P1 — operativos a huésped fallidos (una fila por huésped+regla, la más reciente).
    const guestRules = [...GUEST_OPERATIONAL_RULES];
    const placeholders = guestRules.map(() => "?").join(",");
    const failed = await env.DB.prepare(
      `SELECT to_phone, matched_rule, MAX(created_at) AS at
         FROM whatsapp_messages
        WHERE direction = 'out' AND status = 'failed'
          AND matched_rule IN (${placeholders})
          AND created_at >= datetime('now', '-${DELIVERY_GUEST_LOOKBACK_HOURS} hours')
        GROUP BY to_phone, matched_rule
        ORDER BY at DESC
        LIMIT 10`,
    )
      .bind(...guestRules)
      .all<{ to_phone: string; matched_rule: string; at: string }>();
    let guestAlerts = 0;
    for (const f of failed.results ?? []) {
      issues.push(`guest_fail:${f.to_phone}`);
      if (guestAlerts >= DELIVERY_GUEST_MAX_ALERTS) continue;
      const alerted = await maybeAlert(
        env,
        `delivery_guest_${f.to_phone}`,
        "🔴 WhatsApp al huésped NO llegó",
        f.to_phone,
        `Un mensaje operativo (${f.matched_rule}) a ${f.to_phone} FALLÓ. Motivo en la card 📬 del inbox — si es del check-in, contactalo por otro canal.`,
        f.to_phone, // el botón del template abre ese chat
      );
      if (alerted) {
        alertedAny = true;
        guestAlerts++;
      }
    }

    // P2 — ráfaga sistémica (cualquier regla, followups incluidos).
    const burst = await env.DB.prepare(
      `SELECT COALESCE(matched_rule, '(sin regla)') AS rule, COUNT(*) AS c
         FROM whatsapp_messages
        WHERE direction = 'out' AND status = 'failed'
          AND created_at >= datetime('now', '-${DELIVERY_BURST_WINDOW_MIN} minutes')
        GROUP BY matched_rule
        ORDER BY c DESC`,
    ).all<{ rule: string; c: number }>();
    const burstRows = burst.results ?? [];
    const burstTotal = burstRows.reduce((a, r) => a + r.c, 0);
    if (burstTotal >= DELIVERY_BURST_N) {
      issues.push(`burst:${burstTotal}`);
      const desglose = burstRows.slice(0, 4).map((r) => `${r.rule}×${r.c}`).join(", ");
      const alerted = await maybeAlert(
        env,
        "delivery_burst",
        "🔴 WhatsApp fallando en ráfaga",
        "entrega",
        `${burstTotal} envíos fallaron en ${DELIVERY_BURST_WINDOW_MIN} min (${desglose}). Huele a billing/template/Meta — revisar la card 📬 del inbox.`,
      );
      if (alerted) alertedAny = true;
    }

    // P3 — canal de avisos a dueños caído.
    const beats = await env.DB.prepare(
      `SELECT key, last_at FROM system_heartbeat WHERE key IN ('owner_alert_ok','owner_alert_fail')`,
    ).all<{ key: string; last_at: string }>();
    const byKey: Record<string, string> = {};
    for (const b of beats.results ?? []) byKey[b.key] = b.last_at;
    const failAt = byKey["owner_alert_fail"];
    const okAt = byKey["owner_alert_ok"];
    if (failAt && (!okAt || failAt > okAt)) {
      issues.push("owner_channel_down");
      const alerted = await maybeAlert(
        env,
        "owner_channel",
        "🟠 Avisos a dueños fallando",
        "owner_alerts",
        `El último envío de alertas a dueños FALLÓ. Diagnóstico: POST /api/admin/test-owner-alert. El semáforo "Avisos a dueños" del inbox tiene el estado.`,
      );
      if (alerted) alertedAny = true;
    }
  } catch (err) {
    console.error("checkDeliveryHealth error:", (err as Error).message);
  }
  return { issues, alerted: alertedAny };
}

/** Avisa por WhatsApp si no se avisó lo mismo en las últimas ALERT_COOLDOWN_HOURS. */
async function maybeAlert(
  env: Env,
  cooldownKey: string,
  tipo: string,
  cronKey: string,
  detalle: string,
  guestPhone = "",
): Promise<boolean> {
  const alertKey = `watchdog_alert_${cooldownKey}`;
  const recent = await env.DB.prepare(
    `SELECT 1 AS x FROM system_heartbeat WHERE key = ? AND last_at > datetime('now', ?)`,
  )
    .bind(alertKey, `-${ALERT_COOLDOWN_HOURS} hours`)
    .first<{ x: number }>();
  if (recent) return false; // ya se avisó recientemente, no repetir

  await notifyOwners(env, { tipo, cliente: cronKey, detalle, guestPhone });
  await env.DB.prepare(
    `INSERT INTO system_heartbeat (key, last_at) VALUES (?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
  )
    .bind(alertKey)
    .run();
  return true;
}
