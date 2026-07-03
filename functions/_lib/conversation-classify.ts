/// <reference types="@cloudflare/workers-types" />
//
// Auto-clasificador de conversaciones → etiqueta el DESENLACE de cada chat sin que
// César tenga que hacerlo a mano. Dos capas:
//   1. Determinístico (seguro, sin IA): si el teléfono tiene reserva → "reservo".
//   2. IA (Workers AI) para el resto: lee el transcript y clasifica; si duda → "otro".
// NUNCA pisa una etiqueta puesta a mano (tagged_by='manual').
//
// Se dispara por botón (Centro de Control) o por cron — igual que el QA del bot.
//

import { callWorkersAIJson, type WorkersAIEnv, type AIMessage } from "./workers-ai";

export interface ClassifyEnv extends WorkersAIEnv {
  DB: D1Database;
}

export interface ClassifyResult {
  candidates: number;
  deterministic: number;
  llm: number;
  skipped: number;
}

const VALID_OUTCOMES = new Set(["reservo", "cotizo", "sin_disponibilidad", "precio", "sin_respuesta", "fuera", "otro"]);

// slug → palabras clave para matchear la propiedad que devuelve la IA.
const PROP_KEYS: Record<string, string[]> = {
  "villa-b11-palma-real": ["villa b11", "palma real", "b11", "ceiba"],
  "casa-brisa": ["casa brisa", "brisa", "casita del mar"],
  "casa-marea": ["casa marea", "marea"],
  "las-gemelas-tela": ["gemelas"],
  "centro-morazan": ["centro morazan", "morazán", "morazan", "torre morazan"],
  "casa-lara-townhouse": ["casa lara", "colonia lara", "townhouse"],
  "la-florida": ["florida"],
};
function matchSlug(text: string): string | null {
  const t = (text || "").toLowerCase();
  for (const [slug, keys] of Object.entries(PROP_KEYS)) if (keys.some((k) => t.includes(k))) return slug;
  return null;
}

async function transcript(phone: string, db: D1Database): Promise<string> {
  const res = await db
    .prepare(
      `SELECT direction, body FROM whatsapp_messages
        WHERE from_phone = ? OR to_phone = ?
        ORDER BY created_at DESC, id DESC LIMIT 30`,
    )
    .bind(phone, phone)
    .all<{ direction: string; body: string }>();
  const rows = (res.results ?? []).reverse();
  return rows
    .map((r) => {
      const b = (r.body ?? "").replace(/\s+/g, " ").trim();
      if (!b || b.startsWith("[FAILED]")) return "";
      return r.direction === "in" ? `Cliente: ${b.slice(0, 400)}` : `Nosotros: ${b.slice(0, 400)}`;
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

const CLASSIFY_PROMPT = `Sos un clasificador de conversaciones de WhatsApp de un negocio de alquileres temporales en Honduras (Estadías Jacarí). Leé el chat y decidí en qué quedó la conversación.
Respondé SOLO este JSON, sin texto extra: {"outcome":"...","property":"...","confidence":0.0}
outcome (elegí EXACTAMENTE uno):
- reservo: cerró o confirmó una reserva, o pagó.
- cotizo: pidió o recibió precio/disponibilidad y quedó interesado, pero no cerró todavía.
- sin_disponibilidad: preguntó por fechas que no había disponibles.
- precio: le pareció caro / objetó el precio y no siguió.
- sin_respuesta: dejó de responder sin cerrar (ghosteó).
- fuera: pedía algo que no ofrecemos (otra ciudad, otro servicio).
- otro: no está claro o no aplica.
property: nombre de la propiedad por la que preguntó (ej. "Casa Brisa", "Centro Morazan", "Palma Real"), o "" si no se menciona.
confidence: número 0 a 1 de qué tan seguro estás.`;

interface LlmOut { outcome?: string; property?: string; confidence?: number }

export async function classifyConversations(env: ClassifyEnv, opts: { limit?: number } = {}): Promise<ClassifyResult> {
  const limit = Math.min(opts.limit ?? 25, 60);

  // Candidatos: teléfonos con mensajes entrantes, NO etiquetados a mano, y sin
  // auto-etiqueta al día (hay mensajes más nuevos que la última clasificación).
  const cand = await env.DB
    .prepare(
      `SELECT m.phone AS phone FROM (
         SELECT from_phone AS phone, MAX(created_at) AS last_at
           FROM whatsapp_messages WHERE direction='in' GROUP BY from_phone
       ) m
       LEFT JOIN conversation_tags t ON t.phone = m.phone
       WHERE COALESCE(t.tagged_by,'auto') <> 'manual'
         AND (t.updated_at IS NULL OR m.last_at > t.updated_at)
       ORDER BY m.last_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ phone: string }>()
    .catch(() => ({ results: [] as { phone: string }[] }));
  const phones = (cand.results ?? []).map((r) => r.phone);

  let deterministic = 0, llm = 0, skipped = 0;

  for (const phone of phones) {
    let outcome: string | null = null;
    let property: string | null = null;

    // 1. Determinístico: ¿el teléfono tiene una reserva directa?
    const resv = await env.DB
      .prepare(
        `SELECT property_slug FROM reservations
          WHERE (guest_phone_normalized = ? OR guest_phone = ?)
            AND status IN ('pending','confirmed')
            AND source IN ('website','whatsapp_bot','whatsapp_transfer','manual')
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(phone, phone)
      .first<{ property_slug: string }>()
      .catch(() => null);

    if (resv?.property_slug) {
      outcome = "reservo";
      property = resv.property_slug;
      deterministic++;
    } else {
      // 2. IA
      const t = await transcript(phone, env.DB);
      if (!t) { skipped++; continue; }
      const messages: AIMessage[] = [
        { role: "system", content: CLASSIFY_PROMPT },
        { role: "user", content: t },
      ];
      const res = await callWorkersAIJson<LlmOut>(messages, env, { temperature: 0.1, maxTokens: 200 }).catch(() => null);
      if (!res || !res.ok || !res.data) { skipped++; continue; }
      const out = res.data;
      let o = String(out.outcome || "").toLowerCase().trim();
      const lowConf = typeof out.confidence === "number" && out.confidence < 0.6;
      if (!VALID_OUTCOMES.has(o) || lowConf) o = "otro";
      outcome = o;
      property = matchSlug(String(out.property || "")) ?? null;
      llm++;
    }

    if (!outcome) { skipped++; continue; }
    await env.DB
      .prepare(
        `INSERT INTO conversation_tags (phone, outcome, property_slug, tagged_by, updated_at)
           VALUES (?, ?, ?, 'auto', datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET
           outcome = excluded.outcome,
           property_slug = excluded.property_slug,
           tagged_by = 'auto',
           updated_at = datetime('now')
         WHERE conversation_tags.tagged_by <> 'manual'`,
      )
      .bind(phone, outcome, property)
      .run()
      .catch(() => {});
  }

  return { candidates: phones.length, deterministic, llm, skipped };
}
