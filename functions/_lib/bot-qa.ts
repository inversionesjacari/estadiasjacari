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

/** Trae los teléfonos con actividad reciente (últimos 7 días), más nuevos primero. */
async function recentPhones(db: D1Database): Promise<string[]> {
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
    .all<{ phone: string }>();
  return (res.results ?? []).map((r) => r.phone);
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
  analyzed: number;
  found: number;
  findings: QaFinding[];
  error?: string;
}

/**
 * Corre el análisis completo: revisa las conversaciones recientes, junta los
 * hallazgos y los guarda (reemplazando los anteriores). Devuelve el resumen.
 */
export async function runQaAnalysis(env: QaEnv, trigger: "boton" | "cron"): Promise<QaRunResult> {
  let phones: string[];
  try {
    phones = await recentPhones(env.DB);
  } catch (err) {
    return { analyzed: 0, found: 0, findings: [], error: `recentPhones: ${(err as Error).message}` };
  }
  if (phones.length === 0) {
    return { analyzed: 0, found: 0, findings: [] };
  }

  // Revisar en paralelo (cap chico). Una conversación que falle no rompe el resto.
  const perConv = await Promise.all(phones.map((p) => reviewOne(p, env).catch(() => [] as QaFinding[])));
  const findings = perConv.flat();

  // Persistir: reemplazar hallazgos + registrar la corrida.
  try {
    await env.DB.prepare(`DELETE FROM bot_qa_findings`).run();
    if (findings.length > 0) {
      const stmt = env.DB.prepare(
        `INSERT INTO bot_qa_findings (phone, issue, severity, detail, suggestion) VALUES (?, ?, ?, ?, ?)`,
      );
      await env.DB.batch(findings.map((f) => stmt.bind(f.phone, f.issue, f.severity, f.detail, f.suggestion)));
    }
    await env.DB.prepare(
      `INSERT INTO bot_qa_runs (analyzed, found, trigger) VALUES (?, ?, ?)`,
    )
      .bind(phones.length, findings.length, trigger)
      .run();
  } catch (err) {
    return { analyzed: phones.length, found: findings.length, findings, error: `persistencia: ${(err as Error).message}` };
  }

  return { analyzed: phones.length, found: findings.length, findings };
}
