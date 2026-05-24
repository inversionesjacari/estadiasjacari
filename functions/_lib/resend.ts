/// <reference types="@cloudflare/workers-types" />
//
// Helper compartido de bajo nivel para enviar un email vía la API REST de Resend.
//
// Lo usan tanto el Correo #1 (confirmación de reserva, `email.ts`) como el
// Correo #2 (recordatorio de check-in, `checkin-email.ts`). Centraliza el fetch,
// el manejo de errores y la inyección de `reply_to`, para no duplicar lógica.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint por
// Cloudflare Pages — solo se puede importar desde otros archivos de functions/.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";

export interface ResendEnv {
  RESEND_API_KEY: string;
  EMAIL_FROM: string; // ej. 'Estadías Jacarí <hola@estadiasjacari.com>'
  EMAIL_REPLY_TO?: string;
}

export interface ResendAttachment {
  /** Nombre con el que el cliente verá el adjunto (incluir extensión). */
  filename: string;
  /** Contenido del archivo codificado en base64. */
  content: string;
  /** Opcional: Resend infiere `application/pdf` etc. por la extensión del filename. */
  contentType?: string;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Adjuntos opcionales. Resend acepta hasta 40 MB total por correo. */
  attachments?: ResendAttachment[];
}

export interface SendEmailResult {
  ok: boolean;
  resendId?: string;
  error?: string;
}

/**
 * Envía un email vía Resend. NUNCA lanza excepciones — siempre devuelve un
 * SendEmailResult para que el caller pueda loguear éxito/error en D1.
 */
export async function sendViaResend(
  params: SendEmailParams,
  env: ResendEnv,
): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: "Falta env var RESEND_API_KEY" };
  }
  if (!env.EMAIL_FROM) {
    return { ok: false, error: "Falta env var EMAIL_FROM" };
  }
  if (!params.to) {
    return { ok: false, error: "Destinatario (to) vacío" };
  }

  try {
    const resp = await fetchWithTimeout(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: params.to,
          ...(env.EMAIL_REPLY_TO ? { reply_to: env.EMAIL_REPLY_TO } : {}),
          subject: params.subject,
          html: params.html,
          text: params.text,
          ...(params.attachments && params.attachments.length > 0
            ? { attachments: params.attachments }
            : {}),
        }),
      },
      TIMEOUT.CRITICAL,
    );

    if (!resp.ok) {
      const body = await resp.text();
      return {
        ok: false,
        error: `Resend HTTP ${resp.status}: ${body.slice(0, 300)}`,
      };
    }

    const json = (await resp.json()) as { id?: string };
    return { ok: true, resendId: json.id };
  } catch (err) {
    return {
      ok: false,
      error: `Error de red al llamar a Resend: ${(err as Error).message}`,
    };
  }
}
