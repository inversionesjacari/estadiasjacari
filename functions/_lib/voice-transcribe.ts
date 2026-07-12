/// <reference types="@cloudflare/workers-types" />
//
// voice-transcribe.ts — Transcribe notas de voz de WhatsApp con Workers AI (Whisper).
//
// B6 (2026-07-11): en Honduras se manda MUCHÍSIMO audio. Hoy toda nota de voz
// escala a humano a ciegas ("🎤 Nota de voz — míralo en el inbox"): César tiene
// que ABRIR y ESCUCHAR el audio para saber qué quiere el cliente. Esta v1 la
// vuelve texto legible: la transcribe, el webhook la guarda en el cuerpo del
// mensaje (visible + buscable en el inbox, ahora que B9 tiene búsqueda) y la mete
// en la alerta, para que César la LEA y responda rápido.
//
// A propósito NO hacemos que el bot conteste solo a la voz: una transcripción
// imperfecta (español hondureño, ruido) daría respuestas malas; sigue escalando a
// humano. Esto es la fundación para el paso 2 (que el bot responda) más adelante.
//
// Fail-soft: nunca throws. Si falta el binding AI, el media no baja, o Whisper
// falla/da vacío → { ok:false } y el webhook cae al escalado genérico de siempre
// (cero regresión respecto a hoy).
//
// Carpeta `_lib/` (prefijo underscore) NO es ruteable como endpoint.
//

import { downloadMedia } from "./whatsapp";

// Whisper turbo de Workers AI: rápido y acepta el audio como base64 (justo lo que
// devuelve downloadMedia), sin conversión de formato.
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

export interface TranscribeEnv {
  WHATSAPP_ACCESS_TOKEN?: string;
  AI?: Ai;
}

/**
 * Limpia el texto crudo de Whisper: colapsa espacios/saltos y aplica un tope de
 * longitud. Puro y testeable. Devuelve "" cuando no queda nada útil (audio sin
 * habla, ruido) → el llamador lo trata como "no se pudo transcribir".
 */
export function cleanTranscript(raw: string | null | undefined): string {
  if (!raw) return "";
  const t = raw.replace(/\s+/g, " ").trim();
  // Menos de 2 caracteres no es una frase (ruido, un "a" suelto) — no aporta.
  if (t.length < 2) return "";
  // Tope defensivo: una nota de voz normal no pasa de esto; evita meter un
  // paredón de texto en la alerta/inbox si el audio fue larguísimo.
  return t.slice(0, 1500);
}

interface WhisperOut { text?: string }

/**
 * Baja la nota de voz y la transcribe con Workers AI. Fail-soft: nunca throws;
 * devuelve { ok:false } ante cualquier problema.
 */
export async function transcribeVoiceNote(
  mediaId: string,
  env: TranscribeEnv,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!env.AI) return { ok: false, error: "sin binding AI" };
  try {
    const dl = await downloadMedia(mediaId, env);
    if (!dl.ok || !dl.base64) return { ok: false, error: dl.error ?? "media no bajó" };

    const res = (await env.AI.run(
      WHISPER_MODEL as Parameters<Ai["run"]>[0],
      { audio: dl.base64 } as Parameters<Ai["run"]>[1],
    )) as WhisperOut;

    const text = cleanTranscript(res?.text);
    if (!text) return { ok: false, error: "transcripción vacía" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: `whisper: ${(err as Error).message}` };
  }
}
