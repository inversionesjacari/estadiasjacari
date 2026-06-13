/// <reference types="@cloudflare/workers-types" />
//
// owner-alerts.ts — Aviso por WhatsApp a César + socio cuando algo necesita ojos
// humanos (el bot escaló, reportaron pago, piden llamada, el bot se cayó).
//
// Usa la plantilla UTILITY `alerta_jacari` de Meta, con botón URL dinámico que
// abre el inbox justo en ese chat (?c=<telefono>). Fail-soft: si la plantilla
// aún no está aprobada, o falta config, NO rompe nada — el email de escalación
// sigue siendo el respaldo.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";

const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";
const TEMPLATE_NAME = "alerta_jacari";
const TEMPLATE_LANG = "es";

// Quiénes reciben los avisos (E.164 sin '+'): César + socio.
const OWNER_PHONES = ["50497649035", "50498035697"];

export interface OwnerAlertEnv {
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}

export interface OwnerAlert {
  tipo: string;       // {{1}} — qué pasó (ej. "Reportó pago, verificá")
  cliente: string;    // {{2}} — nombre + teléfono del cliente
  detalle: string;    // {{3}} — contexto (ej. el mensaje del cliente)
  guestPhone: string; // botón — E.164 sin '+' para el link ?c=
}

/**
 * Manda la plantilla `alerta_jacari` a César + socio. Fail-soft: nunca throws.
 * Si falta token/phone-id, no hace nada (silencioso).
 */
export async function notifyOwners(env: OwnerAlertEnv, a: OwnerAlert): Promise<void> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return;

  const components = [
    {
      type: "body",
      parameters: [
        { type: "text", text: (a.tipo || "—").slice(0, 120) },
        { type: "text", text: (a.cliente || "—").slice(0, 120) },
        { type: "text", text: (a.detalle || "—").slice(0, 250) },
      ],
    },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: a.guestPhone || "" }],
    },
  ];

  await Promise.all(
    OWNER_PHONES.map(async (to) => {
      try {
        await fetchWithTimeout(
          `${GRAPH_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to,
              type: "template",
              template: { name: TEMPLATE_NAME, language: { code: TEMPLATE_LANG }, components },
            }),
          },
          TIMEOUT.BEST_EFFORT,
        );
      } catch {
        /* best-effort: el email de escalación es el respaldo */
      }
    }),
  );
}
