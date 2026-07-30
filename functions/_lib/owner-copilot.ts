/// <reference types="@cloudflare/workers-types" />
//
// owner-copilot.ts — MODO PROPIETARIO: cuando César o Eduardo le escriben al
// bot, no son leads — son los dueños. Este módulo es la fuente ÚNICA de
// "quiénes son los dueños" para todo el lado inbound (webhook, métricas,
// followups) y — desde B3 — el copiloto interno que les responde.
//
// owner-alerts.ts importa OWNER_PHONES de acá (destinatarios de alertas =
// dueños reconocidos en la entrada; una sola lista, cero drift).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

/** Dueños de Estadías Jacarí (E.164 sin '+'): César + Eduardo. Confirmados por
 *  César el 2026-07-25 para el modo propietario. */
export const OWNER_PHONES = ["50497649035", "50498035697"] as const;

/** ¿El teléfono es de un dueño? Tolera el '+' inicial y espacios. */
export function isOwnerPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const normalized = phone.replace(/[\s+]/g, "");
  return (OWNER_PHONES as readonly string[]).includes(normalized);
}

/** Literal SQL para `NOT IN (...)` en queries de métricas/followups. Seguro de
 *  interpolar: constantes de módulo, jamás input de usuario. */
export const OWNER_PHONES_SQL = OWNER_PHONES.map((p) => `'${p}'`).join(",");
