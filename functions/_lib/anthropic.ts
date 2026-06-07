/// <reference types="@cloudflare/workers-types" />
//
// Wrapper minimalista para Anthropic API (Claude).
//
// Usado por el bot de WhatsApp para extraer datos estructurados (fechas,
// huéspedes, propiedad) de mensajes en lenguaje natural en español.
//
// Modelo elegido: claude-haiku-4-5 (rápido, barato, suficiente para
// extracción estructurada). Costo aprox: $0.0005 por extracción.
//
// Env var requerida: ANTHROPIC_API_KEY
//
// Por qué wrapper propio en vez de @anthropic-ai/sdk: el SDK pesa ~150KB
// y tiene deps que no funcionan limpiamente en Workers. Una llamada fetch
// directa es 30 líneas y suficiente para nuestro caso de uso.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicEnv {
  ANTHROPIC_API_KEY?: string;
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeResponse {
  ok: boolean;
  text?: string;
  error?: string;
  /** Cuántos tokens consumió la llamada (input + output). Util para auditing. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ClaudeOptions {
  /** Modelo a usar. Default: claude-haiku-4-5 (la opción barata). */
  model?: string;
  /** Prompt sistema (instrucciones). */
  system?: string;
  /** Mensajes de la conversación (al menos uno con role='user'). */
  messages: ClaudeMessage[];
  /** Max tokens en la respuesta. Default 1024. */
  maxTokens?: number;
  /** Temperatura. Default 0 para extracción determinística. */
  temperature?: number;
}

/**
 * Llama a Anthropic Messages API y devuelve el texto de la respuesta de Claude.
 *
 * Fail-soft: si la API falla, devuelve { ok: false, error }. NUNCA throws.
 * El caller decide qué hacer (caer a fallback rule-based, escalar, etc.)
 */
export async function callClaude(
  opts: ClaudeOptions,
  env: AnthropicEnv,
): Promise<ClaudeResponse> {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY no configurado" };
  }
  if (!opts.messages || opts.messages.length === 0) {
    return { ok: false, error: "messages vacío" };
  }

  const body: Record<string, unknown> = {
    model: opts.model ?? "claude-haiku-4-5",
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0,
    messages: opts.messages,
  };
  if (opts.system) body.system = opts.system;

  try {
    const resp = await fetchWithTimeout(
      ANTHROPIC_API_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      TIMEOUT.CRITICAL,
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        ok: false,
        error: `Anthropic API HTTP ${resp.status}: ${errText.slice(0, 300)}`,
      };
    }

    interface AnthropicResp {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    }
    const data = (await resp.json()) as AnthropicResp;
    const textBlock = (data.content ?? []).find((b) => b.type === "text");
    const text = textBlock?.text ?? "";
    return { ok: true, text, usage: data.usage };
  } catch (err) {
    return {
      ok: false,
      error: `Error de red Anthropic: ${(err as Error).message}`,
    };
  }
}

/**
 * Variante helper para cuando esperás JSON estructurado del modelo.
 * Limpia ```json fences si el modelo los pone, y JSON.parse el resultado.
 */
export async function callClaudeJson<T = unknown>(
  opts: ClaudeOptions,
  env: AnthropicEnv,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const resp = await callClaude(opts, env);
  if (!resp.ok || !resp.text) {
    return { ok: false, error: resp.error ?? "Sin respuesta" };
  }
  // Limpiar fences markdown si los hay
  let text = resp.text.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  try {
    const data = JSON.parse(text) as T;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: `Claude devolvió texto no-JSON: ${text.slice(0, 200)}`,
    };
  }
}
