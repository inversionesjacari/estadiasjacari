/// <reference types="@cloudflare/workers-types" />
//
// telegram.ts — Avisos al equipo por un grupo de Telegram.
//
// Por qué Telegram y no un grupo de WhatsApp:
//   La WhatsApp Cloud API NO puede mandar a grupos (solo a personas, 1 a 1).
//   Un grupo de Telegram SÍ se puede vía Bot API: gratis, instantáneo, sin
//   templates de Meta ni riesgo de baneo. El equipo se coordina ahí ("yo lo
//   agarro") y cada aviso trae un botón que abre la conversación en el inbox.
//
// Cuándo dispara (los call sites lo invocan en eventos, no en bucle):
//   - escalado        → el bot escaló / pidió humano / algo fuera de alcance
//   - pago_reportado  → el cliente dice que ya pagó o mandó comprobante
//   - pidio_llamada   → el cliente pidió que lo llamen
//   - esperando       → el cliente quedó sin respuesta hace rato
//   - bot_caido       → el LLM se cayó y el bot quedó mudo
//
// Fail-soft: NUNCA throws. Si Telegram no está configurado o falla, devuelve
// { ok:false } y el flujo del bot sigue igual (el aviso es best-effort).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";

/** WhatsApp directo de César (fallback para tocar el chat del huésped). */
const DEFAULT_BASE_URL = "https://estadiasjacari.com";

export interface TelegramEnv {
  /** Token del bot (BotFather). Secret en Cloudflare. */
  TELEGRAM_BOT_TOKEN?: string;
  /** ID del grupo donde caen los avisos (número negativo). */
  TELEGRAM_CHAT_ID?: string;
  /** Base pública del sitio para armar el link al inbox. */
  PUBLIC_BASE_URL?: string;
}

export type TeamAlertKind =
  | "escalado"
  | "pago_reportado"
  | "pidio_llamada"
  | "esperando"
  | "bot_caido"
  | "prueba";

export interface TeamAlert {
  kind: TeamAlertKind;
  /** Teléfono del huésped en E.164 SIN '+' (ej. "50488390145"). */
  guestPhone?: string;
  /** Nombre del huésped si lo sabemos. */
  guestName?: string;
  /** Nombre legible de la propiedad si lo sabemos. */
  property?: string;
  /** Contexto: el mensaje del cliente, o el error del bot. */
  detail?: string;
}

interface TelegramButton {
  text: string;
  url: string;
}

const TITLES: Record<TeamAlertKind, string> = {
  escalado:       "⚠️ El bot escaló — necesita un humano",
  pago_reportado: "💳 Pago reportado — verificar y confirmar",
  pidio_llamada:  "📞 Cliente pidió que lo llamen",
  esperando:      "🕐 Cliente esperando respuesta",
  bot_caido:      "🤖🔴 El bot está caído (no responde)",
  prueba:         "🔔 Prueba — alertas Jacarí activas",
};

/** ¿Está configurado el bot de Telegram? (token + chat id). */
export function hasTelegram(env: TelegramEnv): boolean {
  return (
    typeof env.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.length > 0 &&
    typeof env.TELEGRAM_CHAT_ID === "string" && env.TELEGRAM_CHAT_ID.length > 0
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** +504 8839-0145 a partir de "50488390145" (best-effort, solo HN de 8 dígitos). */
function prettyPhone(e164: string): string {
  const m = /^504(\d{4})(\d{4})$/.exec(e164);
  return m ? `+504 ${m[1]}-${m[2]}` : `+${e164}`;
}

/**
 * Envía un mensaje al grupo de Telegram. Fail-soft.
 * Usa HTML + botones inline (URL) para que el equipo toque y abra el inbox.
 */
export async function sendTelegramMessage(
  env: TelegramEnv,
  text: string,
  buttons: TelegramButton[] = [],
): Promise<{ ok: boolean; error?: string }> {
  if (!hasTelegram(env)) {
    return { ok: false, error: "Telegram no configurado (falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID)" };
  }

  const body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (buttons.length > 0) {
    body.reply_markup = { inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))] };
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      TIMEOUT.BEST_EFFORT,
    );
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, error: `Telegram error: ${data.description ?? `HTTP ${res.status}`}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Telegram fetch error: ${(err as Error).message}` };
  }
}

/**
 * Arma y envía el aviso al equipo según el tipo de evento. Incluye los datos
 * del huésped (si los hay) y dos botones: abrir en el inbox + WhatsApp directo.
 * Fail-soft: nunca tira; el caller no necesita try/catch.
 */
export async function notifyTeam(
  env: TelegramEnv,
  alert: TeamAlert,
): Promise<{ ok: boolean; error?: string }> {
  const base = (env.PUBLIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

  const lines: string[] = [`<b>${escapeHtml(TITLES[alert.kind])}</b>`];

  if (alert.guestName || alert.guestPhone) {
    const who = alert.guestName ? escapeHtml(alert.guestName) : "Huésped";
    const tel = alert.guestPhone ? ` (${escapeHtml(prettyPhone(alert.guestPhone))})` : "";
    lines.push(`👤 ${who}${tel}`);
  }
  if (alert.property) {
    lines.push(`🏠 ${escapeHtml(alert.property)}`);
  }
  if (alert.detail) {
    const d = alert.detail.length > 280 ? `${alert.detail.slice(0, 280)}…` : alert.detail;
    lines.push("");
    lines.push(`<i>“${escapeHtml(d)}”</i>`);
  }

  const buttons: TelegramButton[] = [];
  if (alert.guestPhone) {
    buttons.push({ text: "📂 Abrir en inbox", url: `${base}/inbox?c=${encodeURIComponent(alert.guestPhone)}` });
    buttons.push({ text: "💬 WhatsApp", url: `https://wa.me/${alert.guestPhone}` });
  } else {
    buttons.push({ text: "📂 Abrir inbox", url: `${base}/inbox` });
  }

  return sendTelegramMessage(env, lines.join("\n"), buttons);
}
