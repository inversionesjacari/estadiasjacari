/// <reference types="@cloudflare/workers-types" />
//
// QA del bot — analizador de conversaciones.
//
// Revisa las conversaciones recientes con IA (Workers AI) y detecta fallos del
// bot: inventos, info incompleta, preguntas sin responder, fallas de memoria,
// frustración del cliente, ventas perdidas, fallas técnicas. Por cada problema
// guarda un hallazgo con un fix SUGERIDO (no aplica nada solo — eso lo revisa
// César o Claude). Cada corrida reemplaza los hallazgos (snapshot fresco).
//
// Disparado por el botón "Analizar" del Centro de Control o por el cron diario.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.

import { callWorkersAIJson, type WorkersAIEnv, type AIMessage } from "./workers-ai";

export interface QaEnv extends WorkersAIEnv {
  DB: D1Database;
}

export interface QaFinding {
  phone: string;
  issue: string;
  severity: "alta" | "media" | "baja";
  detail: string;
  suggestion: string;
}

interface LlmQaOutput {
  findings: { issue: string; severity: string; detail: string; suggestion: string }[];
}

/** Máximo de conversaciones a revisar por corrida (controla tiempo/costo). */
const MAX_CONVERSATIONS = 10;

const QA_SYSTEM_PROMPT = `Sos un auditor de calidad del bot de WhatsApp de Estadías Jacarí (alquileres turísticos SOLO en La Ceiba, Tela y Tegucigalpa). Te paso UNA conversación entre un CLIENTE y el BOT. Tu trabajo: detectar SOLO problemas REALES del bot que valga la pena corregir.

Buscá específicamente:
- El bot INVENTÓ algo (ubicaciones/propiedades/precios/amenidades que no existen, ej. ofrecer Roatán).
- Dio info INCORRECTA o INCOMPLETA.
- IGNORÓ o no respondió una pregunta del cliente.
- REPITIÓ algo que el cliente ya había contestado (falla de memoria).
- FRUSTRÓ al cliente (se quejó, se enojó, o abandonó).
- FALLÓ técnicamente sin recuperarse.
- PERDIÓ una venta que podía cerrar (el cliente estaba listo y el bot lo enredó).
- ESCALÓ mal o prometió algo que no cumplió.

Para CADA problema: issue (tipo corto, 2-4 palabras), severity ("alta"|"media"|"baja"), detail (qué pasó, 1 línea), suggestion (fix CONCRETO: qué regla/FAQ/ajuste haría falta).

Si la conversación estuvo BIEN, devolvé findings vacío []. NO inventes problemas ni seas quisquilloso con detalles menores. Calidad sobre cantidad.

Respondé SOLO este JSON, sin texto extra:
{"findings":[{"issue":"...","severity":"alta|media|baja","detail":"...","suggestion":"..."}]}`;

/** Trae los teléfonos con actividad reciente (últimos 7 días) + su último mensaje. */
async function recentPhones(db: D1Database): Promise<{ phone: string; lastAt: string }[]> {
  const res = await db
    .prepare(
      `SELECT from_phone AS phone, MAX(created_at) AS last_at
         FROM whatsapp_messages
        WHERE direction = 'in' AND created_at >= datetime('now','-7 days')
        GROUP BY from_phone
        ORDER BY last_at DESC
        LIMIT ?`,
    )
    .bind(MAX_CONVERSATIONS)
    .all<{ phone: string; last_at: string }>();
  return (res.results ?? []).map((r) => ({ phone: r.phone, lastAt: r.last_at }));
}

/** Arma el transcript legible de una conversación (últimos ~30 mensajes), con
 *  señales objetivas marcadas (escalado, fallo de envío) para que el evaluador
 *  tenga el contexto que antes no veía. */
async function transcript(phone: string, db: D1Database): Promise<string> {
  const res = await db
    .prepare(
      `SELECT direction, body, escalated, status
         FROM whatsapp_messages
        WHERE from_phone = ? OR to_phone = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 30`,
    )
    .bind(phone, phone)
    .all<{ direction: string; body: string; escalated: number; status: string | null }>();
  const rows = (res.results ?? []).reverse();
  return rows
    .map((r) => {
      const body = (r.body ?? "").replace(/\s+/g, " ").trim();
      if (!body || body.startsWith("[FAILED]")) return "";
      if (r.direction === "in") return `Cliente: ${body.slice(0, 400)}`;
      const flags: string[] = [];
      if (r.escalated) flags.push("escalado a humano");
      if (r.status === "failed") flags.push("NO se entregó");
      return `Bot${flags.length ? ` [${flags.join(", ")}]` : ""}: ${body.slice(0, 400)}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Hallazgos OBJETIVOS (sin LLM) — señales DURAS de que el bot falló en este chat.
 * No dependen del juicio del LLM, así que se detectan SIEMPRE, aunque Workers AI
 * esté con hipos. Cubre justo los chats escalados/mudos que al LLM se le escapaban.
 * Devuelve a lo sumo UN hallazgo (el más relevante) por conversación.
 */
async function objectiveFindings(phone: string, lastAt: string, db: D1Database): Promise<QaFinding[]> {
  try {
    // 1) ¿El bot quedó MUDO por glitch del LLM? (lo más grave)
    const glitch = await db
      .prepare(`SELECT COUNT(*) AS c FROM whatsapp_messages WHERE (from_phone = ? OR to_phone = ?) AND matched_rule = 'bot_glitch_silent'`)
      .bind(phone, phone)
      .first<{ c: number }>();
    if ((glitch?.c ?? 0) > 0) {
      return [{
        phone, issue: "bot mudo por glitch", severity: "alta",
        detail: "El LLM (Workers AI) falló y el bot no pudo responder uno o más mensajes de este chat.",
        suggestion: "Lo cubre la auto-recuperación (cron bot-retry). Si reaparece seguido, el LLM está inestable — mirá el semáforo del Bot IA.",
      }];
    }

    // 2) ¿Quedó ESCALADA a humano? (con el motivo)
    const esc = await db
      .prepare(`SELECT matched_rule FROM whatsapp_messages WHERE (from_phone = ? OR to_phone = ?) AND escalated = 1 ORDER BY created_at DESC LIMIT 1`)
      .bind(phone, phone)
      .first<{ matched_rule: string | null }>();
    if (esc) {
      const reasons: Record<string, string> = {
        out_of_scope_redirect: "pidió algo fuera de alcance (otra zona/servicio)",
        existing_guest_escalation: "huésped existente pidiendo soporte",
        payment_reported: "el cliente reportó que ya pagó",
        transfer_proof_received: "el cliente mandó comprobante de transferencia",
        paypal_usd_requested: "pidió el monto en USD",
        escalar_humano: "el cliente pidió hablar con un humano",
      };
      const rule = esc.matched_rule ?? "";
      return [{
        phone, issue: "escalado a humano", severity: "media",
        detail: `El bot escaló este chat${rule && reasons[rule] ? ` (${reasons[rule]})` : ""}. Te espera para que lo atiendas.`,
        suggestion: "Revisalo en el inbox y respondé a mano si el cliente sigue esperando.",
      }];
    }

    // 3) ¿El último mensaje es del cliente, sin respuesta, hace > 30 min?
    const last = await db
      .prepare(`SELECT direction FROM whatsapp_messages WHERE from_phone = ? OR to_phone = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .bind(phone, phone)
      .first<{ direction: string }>();
    const mins = (Date.now() - new Date(lastAt.replace(" ", "T") + "Z").getTime()) / 60000;
    if (last?.direction === "in" && mins > 30) {
      return [{
        phone, issue: "cliente sin respuesta", severity: "alta",
        detail: `El cliente escribió y nadie respondió en ~${Math.round(mins)} min.`,
        suggestion: "Respondé a mano desde el inbox antes de que se enfríe.",
      }];
    }
  } catch {
    /* best-effort */
  }
  return [];
}

/**
 * Revisa UNA conversación con el LLM → { findings, llmOk }.
 * `llmOk` es false SOLO si el LLM falló técnicamente (no respondió). Distinguirlo
 * de "respondió sin problemas" es clave: si el LLM falla, NO queremos BORRAR los
 * hallazgos previos de esa conversación (ese era el bug que limpiaba hallazgos
 * reales en cada re-corrida).
 */
async function reviewOne(phone: string, env: QaEnv): Promise<{ findings: QaFinding[]; llmOk: boolean }> {
  const text = await transcript(phone, env.DB);
  if (!text || text.length < 30) return { findings: [], llmOk: true }; // corta → nada que reportar
  const messages: AIMessage[] = [
    { role: "system", content: QA_SYSTEM_PROMPT },
    { role: "user", content: `Conversación a auditar:\n\n${text}` },
  ];
  const result = await callWorkersAIJson<LlmQaOutput>(messages, env, { temperature: 0.1, maxTokens: 700 });
  if (!result.ok || !result.data?.findings) return { findings: [], llmOk: false }; // LLM falló
  const sevOk = (s: string): "alta" | "media" | "baja" =>
    s === "alta" || s === "media" || s === "baja" ? s : "media";
  const findings = result.data.findings
    .filter((f) => f && f.issue && f.detail)
    .slice(0, 5) // tope defensivo por conversación
    .map((f) => ({
      phone,
      issue: String(f.issue).slice(0, 80),
      severity: sevOk(String(f.severity)),
      detail: String(f.detail).slice(0, 300),
      suggestion: String(f.suggestion ?? "").slice(0, 400),
    }));
  return { findings, llmOk: true };
}

export interface QaRunResult {
  analyzed: number;  // conversaciones NUEVAS revisadas en esta corrida
  found: number;     // hallazgos abiertos en total
  error?: string;
}

/**
 * Análisis INCREMENTAL: revisa solo las conversaciones con actividad NUEVA
 * desde la última vez que se analizaron (tabla qa_analyzed). Así lo ya
 * revisado/resuelto no reaparece — una conversación se re-revisa solo si el
 * cliente vuelve a escribir. Para cada conversación re-revisada reemplaza SUS
 * hallazgos (los de las demás conversaciones quedan intactos).
 */
export async function runQaAnalysis(env: QaEnv, trigger: "boton" | "cron"): Promise<QaRunResult> {
  let phones: { phone: string; lastAt: string }[];
  try {
    phones = await recentPhones(env.DB);
  } catch (err) {
    return { analyzed: 0, found: 0, error: `recentPhones: ${(err as Error).message}` };
  }

  // Mapa de ya-analizados (phone → último mensaje cuando se analizó).
  const analyzedMap: Record<string, string> = {};
  try {
    const r = await env.DB.prepare(`SELECT phone, last_msg_at FROM qa_analyzed`).all<{ phone: string; last_msg_at: string }>();
    for (const row of r.results ?? []) analyzedMap[row.phone] = row.last_msg_at;
  } catch {
    /* tabla nueva → ninguno analizado */
  }

  // Solo conversaciones con actividad NUEVA (o nunca analizadas).
  const toAnalyze = phones.filter((p) => !analyzedMap[p.phone] || p.lastAt > analyzedMap[p.phone]);

  // Revisar en SERIE (no en paralelo) para no saturar el LLM, que ya es inestable.
  // Por conversación combinamos hallazgos OBJETIVOS (señales duras, sin LLM) +
  // hallazgos del LLM (sutilezas), y persistimos con borrado CONDICIONAL.
  const reviewed: { p: { phone: string; lastAt: string }; objFindings: QaFinding[]; llmFindings: QaFinding[]; llmOk: boolean }[] = [];
  for (const p of toAnalyze) {
    const objFindings = await objectiveFindings(p.phone, p.lastAt, env.DB).catch(() => [] as QaFinding[]);
    const { findings: llmFindings, llmOk } = await reviewOne(p.phone, env).catch(() => ({ findings: [] as QaFinding[], llmOk: false }));
    reviewed.push({ p, objFindings, llmFindings, llmOk });
  }

  try {
    const insert = env.DB.prepare(
      `INSERT INTO bot_qa_findings (phone, issue, severity, detail, suggestion, conv_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const markAnalyzed = (phone: string, lastAt: string) =>
      env.DB
        .prepare(`INSERT INTO qa_analyzed (phone, last_msg_at, analyzed_at) VALUES (?, ?, datetime('now')) ON CONFLICT(phone) DO UPDATE SET last_msg_at = excluded.last_msg_at, analyzed_at = excluded.analyzed_at`)
        .bind(phone, lastAt)
        .run();

    for (const { p, objFindings, llmFindings, llmOk } of reviewed) {
      // Si el LLM FALLÓ técnicamente y no hay señal objetiva → NO borrar los
      // hallazgos previos por un fallo del LLM (este era el bug que los limpiaba).
      if (!llmOk && objFindings.length === 0) {
        await markAnalyzed(p.phone, p.lastAt);
        continue;
      }
      const combined = [...objFindings, ...(llmOk ? llmFindings : [])].slice(0, 6);
      await env.DB.prepare(`DELETE FROM bot_qa_findings WHERE phone = ?`).bind(p.phone).run();
      if (combined.length > 0) {
        await env.DB.batch(combined.map((f) => insert.bind(f.phone, f.issue, f.severity, f.detail, f.suggestion, p.lastAt)));
      }
      await markAnalyzed(p.phone, p.lastAt);
    }
  } catch (err) {
    return { analyzed: toAnalyze.length, found: 0, error: `persistencia: ${(err as Error).message}` };
  }

  // Hallazgos abiertos totales (incluye conversaciones no re-analizadas).
  let found = 0;
  try {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS c FROM bot_qa_findings`).first<{ c: number }>();
    found = c?.c ?? 0;
  } catch {
    /* ignore */
  }

  try {
    await env.DB.prepare(`INSERT INTO bot_qa_runs (analyzed, found, trigger) VALUES (?, ?, ?)`).bind(toAnalyze.length, found, trigger).run();
  } catch {
    /* ignore */
  }

  return { analyzed: toAnalyze.length, found };
}
