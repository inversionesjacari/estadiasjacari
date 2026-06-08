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

/** Arma el transcript legible de una conversación (últimos ~30 mensajes). */
async function transcript(phone: string, db: D1Database): Promise<string> {
  const res = await db
    .prepare(
      `SELECT direction, body
         FROM whatsapp_messages
        WHERE from_phone = ? OR to_phone = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 30`,
    )
    .bind(phone, phone)
    .all<{ direction: string; body: string }>();
  const rows = (res.results ?? []).reverse();
  return rows
    .map((r) => {
      const body = (r.body ?? "").replace(/\s+/g, " ").trim();
      if (!body || body.startsWith("[FAILED]")) return "";
      return `${r.direction === "in" ? "Cliente" : "Bot"}: ${body.slice(0, 400)}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** Revisa UNA conversación → hallazgos (vacío si estuvo bien o si falla el LLM). */
async function reviewOne(phone: string, env: QaEnv): Promise<QaFinding[]> {
  const text = await transcript(phone, env.DB);
  if (!text || text.length < 30) return []; // muy corta para juzgar
  const messages: AIMessage[] = [
    { role: "system", content: QA_SYSTEM_PROMPT },
    { role: "user", content: `Conversación a auditar:\n\n${text}` },
  ];
  const result = await callWorkersAIJson<LlmQaOutput>(messages, env, { temperature: 0.1, maxTokens: 700 });
  if (!result.ok || !result.data?.findings) return [];
  const sevOk = (s: string): "alta" | "media" | "baja" =>
    s === "alta" || s === "media" || s === "baja" ? s : "media";
  return result.data.findings
    .filter((f) => f && f.issue && f.detail)
    .slice(0, 5) // tope defensivo por conversación
    .map((f) => ({
      phone,
      issue: String(f.issue).slice(0, 80),
      severity: sevOk(String(f.severity)),
      detail: String(f.detail).slice(0, 300),
      suggestion: String(f.suggestion ?? "").slice(0, 400),
    }));
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

  // Revisar en paralelo (LLM); las escrituras a D1 después.
  const reviewed = await Promise.all(
    toAnalyze.map(async (p) => ({ p, findings: await reviewOne(p.phone, env).catch(() => [] as QaFinding[]) })),
  );

  try {
    for (const { p, findings } of reviewed) {
      await env.DB.prepare(`DELETE FROM bot_qa_findings WHERE phone = ?`).bind(p.phone).run();
      if (findings.length > 0) {
        const stmt = env.DB.prepare(
          `INSERT INTO bot_qa_findings (phone, issue, severity, detail, suggestion, conv_at) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        await env.DB.batch(findings.map((f) => stmt.bind(f.phone, f.issue, f.severity, f.detail, f.suggestion, p.lastAt)));
      }
      await env.DB
        .prepare(
          `INSERT INTO qa_analyzed (phone, last_msg_at, analyzed_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(phone) DO UPDATE SET last_msg_at = excluded.last_msg_at, analyzed_at = excluded.analyzed_at`,
        )
        .bind(p.phone, p.lastAt)
        .run();
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
