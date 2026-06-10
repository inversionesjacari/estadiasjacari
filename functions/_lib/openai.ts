/// <reference types="@cloudflare/workers-types" />
//
// openai.ts — Cerebro del bot vía OpenAI (GPT-4o-mini).
//
// Por qué existe: Workers AI (Llama) en Cloudflare resultó poco confiable —
// rompe el modo JSON cuando cambian el backend (ej. speculative decoding "-sd"),
// y la cuota gratis (10k neurons/día) se agota en horas; el plan de pago a veces
// ni la levanta (bug de Cloudflare, error 4006). GPT-4o-mini respeta el JSON
// perfecto y cobra por uso real (sin cuota diaria que corte).
//
// Devuelve EXACTAMENTE el mismo tipo que callWorkersAIJson → es intercambiable.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { tryParseJson, type AIMessage, type AIJsonResponse, type WorkersAIEnv } from "./workers-ai";

const OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
  error?: { message?: string };
}

/** ¿Está configurada la API key de OpenAI? (secret OPENAI_API_KEY en Cloudflare). */
export function hasOpenAI(env: WorkersAIEnv): boolean {
  return typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0;
}

/**
 * Llama a GPT-4o-mini pidiendo JSON estructurado. Mismo contrato que
 * callWorkersAIJson: fail-soft, NUNCA throws; devuelve { ok, data | error, rawText }.
 */
export async function callOpenAIJson<T = unknown>(
  messages: AIMessage[],
  env: WorkersAIEnv,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<AIJsonResponse<T>> {
  if (!hasOpenAI(env)) {
    return { ok: false, error: "OPENAI_API_KEY no configurada", tokensUsed: 0 };
  }

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: opts.temperature ?? 0.15,
        max_tokens: opts.maxTokens ?? 600,
        response_format: { type: "json_object" },
      }),
    });

    const data = (await res.json().catch(() => ({}))) as OpenAIChatResponse;

    if (!res.ok) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, error: `OpenAI error: ${msg}`, tokensUsed: 0 };
    }

    const rawText = data.choices?.[0]?.message?.content ?? "";
    const tokensUsed = data.usage?.total_tokens ?? 0;

    const parsed = tryParseJson<T>(rawText);
    if (parsed !== null) {
      return { ok: true, data: parsed, tokensUsed };
    }
    // OpenAI casi siempre da JSON válido; si no, guardamos el texto por si sirve.
    return {
      ok: false,
      error: `Respuesta no-JSON de OpenAI: ${rawText.slice(0, 300)}`,
      rawText,
      tokensUsed,
    };
  } catch (err) {
    return { ok: false, error: `OpenAI fetch error: ${(err as Error).message}`, tokensUsed: 0 };
  }
}
