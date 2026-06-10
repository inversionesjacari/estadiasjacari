/// <reference types="@cloudflare/workers-types" />
//
// Wrapper para Cloudflare Workers AI.
//
// Modelo: @cf/meta/llama-3.3-70b-instruct-fp8-fast
//   - Llama 3.3 70B cuantizado a FP8 — máxima calidad en el tier gratuito
//   - Tier gratuito: 10,000 requests/día (más que suficiente para ~200 leads/mes)
//   - Contexto: 128K tokens
//
// BINDING REQUERIDO en Cloudflare Pages:
//   - Ve a tu proyecto en dash.cloudflare.com → Settings → Functions → AI Bindings
//   - Variable name: AI  (exactamente "AI" en mayúsculas)
//   - Guardá y hace deploy
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// Red de respaldo: si el modelo principal (70B) agota sus reintentos, caemos a un
// modelo más chico y de OTRO backend (8B "-fast", vigente, no deprecado). Responde
// la mayoría de las veces que el 70B tiene un hipo → el cliente recibe respuesta
// (quizá un poco más simple) en vez de silencio.
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export interface WorkersAIEnv {
  /** Cloudflare Workers AI binding. Variable name en Cloudflare Pages debe ser "AI". */
  AI?: Ai;
  /** API key de OpenAI (secret en Cloudflare Pages). Si está presente, el bot usa
   *  GPT-4o-mini como cerebro principal (respeta JSON, sin cuota diaria de Cloudflare).
   *  Workers AI queda como respaldo. */
  OPENAI_API_KEY?: string;
}

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AITextResponse {
  ok: boolean;
  text?: string;
  error?: string;
  tokensUsed: number;
}

export interface AIJsonResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Texto crudo del modelo cuando NO parsea como JSON. Habilita el "modo
   *  degradado": si Cloudflare rompe el modo JSON del modelo (y responde texto
   *  plano), usamos ese texto como respuesta en vez de descartarlo. */
  rawText?: string;
  tokensUsed: number;
}

// Tipo interno de lo que devuelve Workers AI para modelos de chat
interface WorkersAIChatResult {
  response?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Extrae el texto de la respuesta de Workers AI independientemente del formato. */
function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as WorkersAIChatResult;
    if (r.response != null) return String(r.response);
  }
  return JSON.stringify(result);
}

/** Extrae tokens usados de la respuesta de Workers AI. */
function extractTokens(result: unknown): number {
  if (result && typeof result === "object") {
    const r = result as WorkersAIChatResult;
    return r.usage?.total_tokens ?? 0;
  }
  return 0;
}

/**
 * Ejecuta env.AI.run con reintentos. Workers AI a veces falla esporádicamente
 * (saturación/timeout), sobre todo con llamadas concurrentes. 2 intentos con
 * un pequeño backoff reducen mucho los fallos visibles para el cliente.
 */
async function aiRunWithRetry(
  env: WorkersAIEnv,
  payload: unknown,
  model: string,
  attempts = 5,
): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await env.AI!.run(model as Parameters<Ai["run"]>[0], payload as Parameters<Ai["run"]>[1]);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        // Backoff exponencial capeado: 400ms, 800ms, 1600ms, 2500ms (~5.3s total).
        // Recupera los hipos BREVES de Workers AI dentro del mismo request, sin que
        // el cliente note nada. Los hipos LARGOS los cubre el reintento diferido (cron).
        await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** i, 2500)));
      }
    }
  }
  throw lastErr;
}

/**
 * Corre el modelo PRINCIPAL (70B) con reintentos; si agota todos, cae al modelo
 * de RESPALDO (8B). Así un hipo del 70B no deja al cliente sin respuesta — la red
 * de respaldo que pidió César.
 */
async function aiRunWithFallback(env: WorkersAIEnv, payload: unknown): Promise<unknown> {
  try {
    // Reintentos moderados: 2 al 70B (no 5). Reintentar de más cuando la IA está
    // saturada solo la satura más. El reintento DIFERIDO (cron) cubre el resto.
    return await aiRunWithRetry(env, payload, MODEL, 2);
  } catch (errPrimary) {
    console.error("Workers AI 70B falló, probando respaldo 8B:", (errPrimary as Error).message);
    return await aiRunWithRetry(env, payload, FALLBACK_MODEL, 1);
  }
}

/**
 * Llama a Workers AI (Llama 3.3) con los mensajes dados y devuelve texto.
 * Fail-soft: nunca throws, devuelve { ok: false, error } si algo falla.
 */
export async function callWorkersAI(
  messages: AIMessage[],
  env: WorkersAIEnv,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<AITextResponse> {
  if (!env.AI) {
    return {
      ok: false,
      error: 'Workers AI binding no configurado. Ir a Cloudflare Pages → Settings → AI Bindings → añadir binding con nombre "AI".',
      tokensUsed: 0,
    };
  }

  try {
    const result = await aiRunWithFallback(env, {
      messages,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 512,
    });

    return {
      ok: true,
      text: extractText(result),
      tokensUsed: extractTokens(result),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Workers AI error: ${(err as Error).message}`,
      tokensUsed: 0,
    };
  }
}

/**
 * Variante JSON: pide al modelo JSON estructurado vía response_format.
 * Limpia fences markdown si el modelo los incluye, y extrae el primer objeto {}.
 * Retry con limpieza agresiva si el primer parse falla.
 */
export async function callWorkersAIJson<T = unknown>(
  messages: AIMessage[],
  env: WorkersAIEnv,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<AIJsonResponse<T>> {
  if (!env.AI) {
    return {
      ok: false,
      error: 'Workers AI binding no configurado. Variable name debe ser "AI" en Cloudflare Pages.',
      tokensUsed: 0,
    };
  }

  try {
    const result = await aiRunWithFallback(env, {
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 512,
      response_format: { type: "json_object" },
    });

    const rawText = extractText(result);
    const tokensUsed = extractTokens(result);

    const parsed = tryParseJson<T>(rawText);
    if (parsed !== null) {
      return { ok: true, data: parsed, tokensUsed };
    }

    return {
      ok: false,
      error: `Respuesta no-JSON del modelo: ${rawText.slice(0, 300)}`,
      rawText,
      tokensUsed,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Workers AI JSON error: ${(err as Error).message}`,
      tokensUsed: 0,
    };
  }
}

/**
 * Intenta parsear JSON de un string, incluyendo limpieza de fences y extracción
 * del primer {} válido si hay texto extra alrededor.
 */
export function tryParseJson<T>(raw: string): T | null {
  // 1. Intento directo
  try { return JSON.parse(raw) as T; } catch { /* continúa */ }

  // 2. Limpiar fences markdown
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try { return JSON.parse(text) as T; } catch { /* continúa */ }
  }

  // 3. Extraer primer objeto {} del texto
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) as T; } catch { /* continúa */ }
  }

  return null;
}
