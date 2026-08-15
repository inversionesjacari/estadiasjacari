/// <reference types="@cloudflare/workers-types" />
//
// GET /api/inbox/reservations-confirmed
//
// Alimenta el dashboard /inbox/reservas. Lista TODAS las reservas activas
// (status 'confirmed' = pago completo, o 'pending' = depósito 50% / por verificar)
// cuyo check_out aún no pasó. Ordenadas por check_in (las más próximas primero).
//
// Incluye las columnas wa_*_sent_at para que el dashboard muestre, de un vistazo,
// qué mensajes ya salieron (T-1 instrucciones, huésped día-de, limpieza, seguridad)
// y a quién le falta seguimiento. Hace LEFT JOIN al último comprobante de
// transferencia de cada reserva para distinguir "Depósito 50%" de "Por verificar".
//
// CHATVIVO (2026-07-16): además adjunta `wa[]` por reserva — el último intento de
// cada template POR DESTINATARIO leído de `whatsapp_messages` (las filas que deja
// wa-log). Con eso el dashboard deja de decir "enviado" = "Meta lo aceptó" y pasa
// a reflejar la ENTREGA real (sent→delivered→read→failed, que el callback de Meta
// actualiza por wamid): un fallo ASÍNCRONO (clase billing 131042) ya no queda
// verde para siempre. El motivo del fallo viaja YA legible (metaCodeLabel) — el
// front no traduce nada — y `to` es el teléfono real del destinatario (huésped o
// STAFF), que el front usa para el link "💬 ver chat" al hilo en vivo del inbox.
// Todo el bloque es FAIL-SOFT: si la query falla, el dashboard sigue con las
// columnas wa_* de siempre.
//
// Protegido con la cookie de sesión del inbox.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { redactMoney } from "../../_lib/inbox-roles";
import { todayHn } from "../../_lib/dates";
import { metaCodeLabel, parseWaFailTrace, type WaFailTrace } from "../../_lib/delivery-policy";

interface Env {
  DB: D1Database;
  INBOX_PASSWORD?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Columnas nuevas de RECORDATORIOS-0712: víspera de limpieza (schema/0041) +
// los errores por mensaje, para que el checklist muestre ⚠ con el motivo.
// Exportadas solo para el test que fija el contrato del fallback.
export const SELECT_FULL = `SELECT r.id, r.property_slug, r.check_in, r.check_out, r.guest_name,
        r.guest_phone, r.guest_count, r.amount_usd, r.total_hnl, r.paid_hnl, r.source, r.status, r.created_at,
        r.notified_at, r.checkin_reminder_sent_at, r.checkin_reminder_error,
        r.whatsapp_sent_at, r.whatsapp_error,
        r.wa_arrival_guest_sent_at, r.wa_arrival_guest_error,
        r.wa_arrival_cleaning_sent_at, r.wa_arrival_cleaning_error,
        r.wa_arrival_security_sent_at, r.wa_arrival_security_error,
        r.wa_departure_guest_sent_at, r.wa_departure_guest_error,
        r.wa_departure_cleaning_sent_at, r.wa_departure_cleaning_error,
        r.wa_phone_capture_sent_at,
        r.wa_eve_cleaning_sent_at, r.wa_eve_cleaning_error,
        r.security_id_key, r.security_id_captured_at,
        tr.amount AS tr_amount, tr.expected_hnl AS tr_expected_hnl,
        tr.currency AS tr_currency, tr.decision AS tr_decision
   FROM reservations r
   LEFT JOIN transfer_receipts tr
     ON tr.id = (
       SELECT t2.id FROM transfer_receipts t2
        WHERE t2.reservation_id = r.id
        ORDER BY t2.id DESC LIMIT 1
     )
  WHERE r.status IN ('confirmed', 'pending')
    AND r.check_out >= ?
  ORDER BY r.check_in ASC, r.created_at DESC
  LIMIT 200`;

// Fallbacks progresivos por si el código se despliega ANTES de que corran las
// migraciones en la D1 remota: cada nivel quita un bloque de columnas nuevas y
// el dashboard sigue vivo en vez de morir con "no such column".
//   FULL       → con 0041 (víspera) + 0043 (foto ID)
//   NO_SEC     → sin 0043 (foto ID)         [si 0043 no aplicó]
//   LEGACY     → sin 0041 ni 0043           [si tampoco aplicó 0041]
const SEC_ID_BLOCK = `
        r.security_id_key, r.security_id_captured_at,`;
const EVE_BLOCK = `
        r.wa_eve_cleaning_sent_at, r.wa_eve_cleaning_error,`;
export const SELECT_NO_SEC = SELECT_FULL.replace(SEC_ID_BLOCK, "");
export const SELECT_LEGACY = SELECT_NO_SEC.replace(EVE_BLOCK, "");

// ── Entrega real por touchpoint (CHATVIVO) ──────────────────────────────────

// Los matched_rule con los que wa-log registra los envíos que este dashboard
// pinta como chips. Espejo de los touchpoints del front (reservas/page.tsx):
// `checkin_reminder` = PDF de instrucciones (cron T-1 / paypal mismo-día);
// los tpl_* los escribe whatsapp-dispatch (`tpl_${template}`).
export const DASHBOARD_WA_RULES = [
  "checkin_reminder",
  "tpl_checkin_dia_huesped",
  "tpl_checkout_dia_huesped",
  "tpl_checkin_dia_limpieza",
  "tpl_checkout_dia_limpieza",
  "tpl_checkin_dia_seguridad",
  "tpl_limpieza_aviso_entrada",
] as const;

export interface WaMsgRow {
  id: number;
  reservation_id: number;
  matched_rule: string;
  to_phone: string;
  status: string | null;
  created_at: string;
  meta_message_id: string | null;
  body: string | null;
}

/** Lo que el dashboard recibe por envío: destinatario real + entrega + motivo legible. */
export interface WaEntry {
  rule: string;
  /** Teléfono E.164 sin '+' del destinatario REAL (huésped o staff) — el front arma /inbox?c=<to>. */
  to: string;
  /** sent | delivered | read | failed (lo actualiza el callback de Meta por wamid). */
  status: string | null;
  at: string;
  /** Solo si failed: motivo YA legible (metaCodeLabel / parseWaFailTrace). */
  reason: string | null;
  /** Solo si failed: el detalle crudo/exacto de Meta, para el tooltip. */
  detail: string | null;
}

/**
 * Se queda con el ÚLTIMO intento por (reserva, regla, destinatario): un reenvío
 * manual exitoso pisa el intento fallido anterior a ese MISMO destinatario, pero
 * no esconde el fallo de OTRO destinatario (limpieza puede ser 2 personas).
 * Pura y exportada para el test.
 */
export function latestPerTarget(rows: WaMsgRow[]): WaMsgRow[] {
  const m = new Map<string, WaMsgRow>();
  for (const r of rows) {
    const key = `${r.reservation_id}|${r.matched_rule}|${r.to_phone}`;
    const prev = m.get(key);
    if (!prev || r.id > prev.id) m.set(key, r);
  }
  return [...m.values()];
}

/**
 * Error SÍNCRONO de un envío fallido: wa-log guarda el body como
 * "[FAILED] <resumen>\n\nERROR: <crudo de Meta>". Devuelve el crudo o null.
 * Pura y exportada para el test.
 */
export function syncErrorOf(body: string | null): string | null {
  if (!body || !body.startsWith("[FAILED]")) return null;
  const i = body.indexOf("ERROR:");
  const raw = i >= 0 ? body.slice(i + "ERROR:".length).trim() : "";
  return raw || null;
}

/**
 * Motivo legible de un fallo. Prioridad: el trace WA_DELIVERY_FAILED (fallo
 * ASÍNCRONO — Meta aceptó y después rechazó; trae código+título exactos). Si no
 * hay trace, intenta sacar el código del error síncrono crudo. Siempre devuelve
 * algo mostrable. Pura y exportada para el test.
 */
export function failReason(
  syncRaw: string | null,
  trace: WaFailTrace | null,
): { reason: string; detail: string | null } {
  if (trace) {
    const detail = [trace.title, trace.rest].filter(Boolean).join(" — ") || null;
    return { reason: metaCodeLabel(trace.code), detail: detail ?? syncRaw };
  }
  if (syncRaw) {
    const m = syncRaw.match(/"code"\s*:\s*(\d+)/) ?? syncRaw.match(/\bcode[=:]\s*(\d+)/);
    const code = m ? Number(m[1]) : null;
    return { reason: code != null ? metaCodeLabel(code) : "Meta rechazó el envío", detail: syncRaw };
  }
  return { reason: "Meta reportó fallo de entrega (sin detalle)", detail: null };
}

/**
 * Filas crudas → entradas por reserva, con el motivo resuelto para los failed.
 * Pura y exportada para el test.
 */
export function toWaEntries(
  rows: WaMsgRow[],
  traceByWamid: Map<string, WaFailTrace>,
): Map<number, WaEntry[]> {
  const by = new Map<number, WaEntry[]>();
  for (const r of latestPerTarget(rows)) {
    let reason: string | null = null;
    let detail: string | null = null;
    if (r.status === "failed") {
      const sync = syncErrorOf(r.body);
      const trace = r.meta_message_id ? (traceByWamid.get(r.meta_message_id) ?? null) : null;
      ({ reason, detail } = failReason(sync, trace));
    }
    const arr = by.get(r.reservation_id) ?? [];
    arr.push({ rule: r.matched_rule, to: r.to_phone, status: r.status, at: r.created_at, reason, detail });
    by.set(r.reservation_id, arr);
  }
  return by;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireInboxAuth(request, env);
  if (!auth.ok) return auth.response!;

  const variants = [SELECT_FULL, SELECT_NO_SEC, SELECT_LEGACY];
  try {
    for (let i = 0; i < variants.length; i++) {
      try {
        const rows = await env.DB.prepare(variants[i]).bind(todayHn()).all();
        const results = (rows.results ?? []) as Array<Record<string, unknown> & { id: number; created_at?: string }>;
        // Cota inferior del scan: ningún envío de estas reservas puede ser anterior
        // a la creación de la más vieja (wa-log corre siempre DESPUÉS del insert).
        const minCreatedAt = results.reduce<string | null>((acc, r) => {
          const c = typeof r.created_at === "string" ? r.created_at : null;
          return c && (!acc || c < acc) ? c : acc;
        }, null);
        const waByRes = await fetchWaEntries(env.DB, results.map((r) => r.id), minCreatedAt);
        const withWa = waByRes
          ? results.map((r) => ({ ...r, wa: waByRes.get(r.id) ?? [] }))
          : results;
        // Empleado (rol staff): sin montos, con `pay_state`. Sigue viendo el
        // checklist de entrega (que es su trabajo) y si falta cobrar o no.
        return json({ ok: true, reservations: redactMoney(withWa, auth.session) });
      } catch (err) {
        // Solo bajamos de nivel si es columna faltante y queda otro fallback.
        if (i === variants.length - 1 || !/no such column/i.test((err as Error).message)) throw err;
      }
    }
    return json({ ok: true, reservations: [] });
  } catch (err) {
    return json({ ok: false, error: `D1: ${(err as Error).message}` }, 500);
  }
};

/**
 * Trae la entrega real de los envíos de estas reservas. FAIL-SOFT: cualquier
 * error devuelve null y el dashboard sigue con las columnas wa_* de siempre.
 *
 * Notas D1 (revisión adversaria 16-jul):
 * - NO se bindean los ids (límite de ~100 parámetros por query y acá pueden ser
 *   200) — se filtra por matched_rule (7 valores) + created_at >= minCreatedAt
 *   (aprovecha idx direction/created y evita escanear el historial completo en
 *   cada poll de 30s) y se cruza contra el set de ids en JS.
 * - Los traces WA_DELIVERY_FAILED se buscan por el wamid EXACTO de las filas
 *   fallidas (no "los últimos 400"): en una tormenta de fallos (clase billing
 *   131042) el motivo del touchpoint no se pierde entre cientos de traces ajenos.
 */
async function fetchWaEntries(
  db: D1Database,
  ids: number[],
  minCreatedAt: string | null,
): Promise<Map<number, WaEntry[]> | null> {
  if (ids.length === 0) return new Map();
  try {
    const rulePh = DASHBOARD_WA_RULES.map(() => "?").join(",");
    const res = await db
      .prepare(
        `SELECT id, reservation_id, matched_rule, to_phone, status, created_at, meta_message_id, body
           FROM whatsapp_messages
          WHERE direction = 'out'
            AND reservation_id IS NOT NULL
            AND matched_rule IN (${rulePh})
            AND created_at >= ?
          ORDER BY id DESC
          LIMIT 2000`,
      )
      .bind(...DASHBOARD_WA_RULES, minCreatedAt ?? "1970-01-01 00:00:00")
      .all<WaMsgRow>();
    const idSet = new Set(ids);
    const rows = (res.results ?? []).filter((r) => idSet.has(r.reservation_id));

    // Traces WA_DELIVERY_FAILED de ESTOS wamids fallidos (motivo del fallo async).
    const traceByWamid = new Map<string, WaFailTrace>();
    const failedWamids = [
      ...new Set(rows.filter((r) => r.status === "failed" && r.meta_message_id).map((r) => r.meta_message_id!)),
    ].slice(0, 40); // tope de params (límite D1 ~100); 40 fallos visibles a la vez no pasa en la práctica
    if (failedWamids.length > 0) {
      try {
        const likes = failedWamids.map(() => `detail LIKE ?`).join(" OR ");
        const tr = await db
          .prepare(`SELECT detail FROM bot_trace WHERE stage = 'WA_DELIVERY_FAILED' AND (${likes}) ORDER BY at DESC LIMIT 200`)
          .bind(...failedWamids.map((w) => `%wamid=${w} %`))
          .all<{ detail: string }>();
        for (const t of tr.results ?? []) {
          // El LIKE puede traer falsos positivos ('_' comodín); el parse + index
          // por wamid exacto los vuelve inofensivos.
          const p = parseWaFailTrace(t.detail);
          if (p.wamid && !traceByWamid.has(p.wamid)) traceByWamid.set(p.wamid, p);
        }
      } catch {
        /* sin traces → el motivo cae al error síncrono o al default */
      }
    }
    return toWaEntries(rows, traceByWamid);
  } catch {
    return null;
  }
}
