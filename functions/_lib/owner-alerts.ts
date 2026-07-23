/// <reference types="@cloudflare/workers-types" />
//
// owner-alerts.ts — Aviso por WhatsApp a César + socio cuando algo necesita ojos
// humanos (el bot escaló, reportaron pago, piden llamada, el bot se cayó).
//
// Usa la plantilla UTILITY `alerta_jacari` de Meta (APROBADA — verificado por
// César 2026-07-11), con botón URL dinámico que abre el inbox justo en ese chat
// (?c=<telefono>). Fail-soft: nunca throws — el email de escalación sigue siendo
// el respaldo.
//
// ⚠️ Lección B8 (2026-07-11): fail-soft SIN registrar el error = fail-SILENT.
// La versión anterior descartaba la respuesta de Meta: si el envío fallaba
// (template mal calzado, parámetro vacío, token), NADIE se enteraba y César
// creía que las alertas llegaban. Ahora cada envío deja rastro:
//   - heartbeat `owner_alert_ok` / `owner_alert_fail` en `system_heartbeat`
//     (para el semáforo del inbox y el watchdog),
//   - fila en `bot_trace` (stage OWNER_ALERT_FAIL) con el error EXACTO de Meta,
//   - y devuelve el resultado por destinatario (lo usa /api/admin/test-owner-alert
//     para diagnosticar en un solo paso).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";

const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";
const TEMPLATE_NAME = "alerta_jacari";
const TEMPLATE_LANG = "es";

// Quiénes reciben los avisos (E.164 sin '+'): César + socio.
const OWNER_PHONES = ["50497649035", "50498035697"];

export interface OwnerAlertEnv {
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  /** Opcional: si viene, el resultado de cada envío queda registrado en D1
   *  (heartbeats + bot_trace). Sin DB, el envío funciona igual pero sin rastro. */
  DB?: D1Database;
}

export interface OwnerAlert {
  tipo: string;       // {{1}} — qué pasó (ej. "Reportó pago, verificá")
  cliente: string;    // {{2}} — nombre + teléfono del cliente
  detalle: string;    // {{3}} — contexto (ej. el mensaje del cliente)
  guestPhone: string; // botón — E.164 sin '+' para el link ?c=
}

/** Resultado de un intento de alerta a UN dueño. */
export interface OwnerAlertSendResult {
  to: string;
  ok: boolean;
  status?: number;      // HTTP status de Meta (undefined si ni siquiera respondió)
  messageId?: string;   // wamid si Meta lo aceptó
  error?: string;       // body/mensaje de error EXACTO (truncado)
}

export interface OwnerAlertResult {
  ok: boolean; // true si TODOS los envíos salieron bien
  skipped: boolean; // true si faltó config y no se intentó nada
  results: OwnerAlertSendResult[];
}

/**
 * Meta RECHAZA parámetros de body con salto de línea/tab o 4+ espacios seguidos
 * (error #132018 "Param text cannot have new-line/tab characters or more than 4
 * consecutive spaces"). Los leads de EVENTO (detalle multilínea con el mensaje
 * del cliente) caían JUSTO acá y nunca disparaban la alerta a César/socio — el
 * subconjunto de mayor plata (bodas 25-65 pax) invisible durante 11 días.
 *
 * Colapsa CUALQUIER corrida de espacios en blanco (incluye \n \r \t) a un solo
 * espacio ANTES de truncar, así ningún parámetro tumba el envío. Función pura.
 */
export function sanitizeParam(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/**
 * Arma los components del template `alerta_jacari`. Función PURA (testeable):
 * 3 parámetros de body (sanitizados + truncados a los límites de Meta) + 1 botón
 * URL dinámico.
 *
 * Nota del botón: Meta RECHAZA parámetros vacíos (error 131008/132012). Las
 * alertas de sistema (watchdog) no tienen cliente → guestPhone viene "" → se
 * manda "0" y el inbox abre en la vista general (?c=0 no matchea ningún chat).
 */
export function buildAlertComponents(a: OwnerAlert): unknown[] {
  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: sanitizeParam(a.tipo).slice(0, 120) || "—" },
        { type: "text", text: sanitizeParam(a.cliente).slice(0, 120) || "—" },
        { type: "text", text: sanitizeParam(a.detalle).slice(0, 250) || "—" },
      ],
    },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: sanitizeParam(a.guestPhone) || "0" }],
    },
  ];
}

/** Latido en system_heartbeat (best-effort, nunca throws). */
async function beat(db: D1Database | undefined, key: string): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO system_heartbeat (key, last_at) VALUES (?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET last_at = datetime('now')`,
    ).bind(key).run();
  } catch { /* best-effort */ }
}

/** Cámara en bot_trace (best-effort, nunca throws). */
async function trace(db: D1Database | undefined, phone: string, detail: string): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'OWNER_ALERT_FAIL', ?)`,
    ).bind(phone, detail.slice(0, 500)).run();
  } catch { /* best-effort */ }
}

/**
 * Manda la plantilla `alerta_jacari` a César + socio. Fail-soft: nunca throws.
 * Si falta token/phone-id, no hace nada (skipped=true) — pero eso también deja
 * latido de fallo, porque una config ausente ES un canal de alerta caído.
 */
export async function notifyOwners(env: OwnerAlertEnv, a: OwnerAlert): Promise<OwnerAlertResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    await beat(env.DB, "owner_alert_fail");
    await trace(env.DB, "", "config faltante: WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID");
    return { ok: false, skipped: true, results: [] };
  }

  const components = buildAlertComponents(a);

  const results = await Promise.all(
    OWNER_PHONES.map(async (to): Promise<OwnerAlertSendResult> => {
      try {
        const res = await fetchWithTimeout(
          `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to,
              type: "template",
              template: { name: TEMPLATE_NAME, language: { code: TEMPLATE_LANG }, components },
            }),
          },
          TIMEOUT.BEST_EFFORT,
        );

        const bodyText = await res.text().catch(() => "");
        if (!res.ok) {
          // El error EXACTO de Meta (código + mensaje) — la diferencia entre
          // diagnosticar en 1 minuto y teorizar por semanas.
          return { to, ok: false, status: res.status, error: bodyText.slice(0, 500) };
        }
        let messageId: string | undefined;
        try {
          messageId = (JSON.parse(bodyText) as { messages?: Array<{ id?: string }> })
            .messages?.[0]?.id;
        } catch { /* body no-JSON con 200 — raro pero no es fallo */ }
        return { to, ok: true, status: res.status, messageId };
      } catch (err) {
        // Timeout o error de red — tampoco se traga.
        return { to, ok: false, error: (err as Error).message.slice(0, 500) };
      }
    }),
  );

  const allOk = results.every((r) => r.ok);
  if (allOk) {
    await beat(env.DB, "owner_alert_ok");
  } else {
    await beat(env.DB, "owner_alert_fail");
    for (const r of results.filter((x) => !x.ok)) {
      await trace(env.DB, r.to, `HTTP ${r.status ?? "—"} :: ${r.error ?? "sin detalle"} :: tipo="${a.tipo.slice(0, 80)}"`);
    }
  }

  return { ok: allOk, skipped: false, results };
}
