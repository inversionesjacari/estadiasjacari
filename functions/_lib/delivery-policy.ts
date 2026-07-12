//
// delivery-policy.ts — Funciones PURAS de la salud de entrega de WhatsApp.
//
// (1) Parsear los traces WA_DELIVERY_FAILED que escribe el webhook (formato real
//     de whatsapp-webhook.ts handleStatusUpdate: "wamid=X to=Y code=Z Título :: detalle").
// (2) Traducir códigos de error de Meta a etiquetas humanas para la card.
// (3) Clasificar la regla del mensaje fallido → decide la política de alerta del
//     watchdog (operativo a huésped = alertar SIEMPRE; re-engagement suelto = solo card).
//
// Puras y sin D1 a propósito: testeables en vitest sin stubs (convención del repo).
//

import { GUEST_OPERATIONAL_RULES, STAFF_OPERATIONAL_RULES } from "./wa-log";

export interface WaFailTrace {
  wamid: string | null;
  to: string | null;
  code: number | null;
  title: string;
  rest: string;
}

/**
 * Parsea el `detail` de un bot_trace WA_DELIVERY_FAILED. Formato que escribe el
 * webhook: `wamid=<id> to=<phone> code=<n> <título> :: <detalle>` (truncado a 500).
 * Tolerante: campos ausentes o "?" quedan null/"" — nunca lanza.
 */
export function parseWaFailTrace(detail: string | null | undefined): WaFailTrace {
  const out: WaFailTrace = { wamid: null, to: null, code: null, title: "", rest: "" };
  if (!detail) return out;

  const wamidMatch = detail.match(/wamid=(\S+)/);
  if (wamidMatch && wamidMatch[1] !== "?") out.wamid = wamidMatch[1];

  const toMatch = detail.match(/\bto=(\S+)/);
  if (toMatch && toMatch[1] !== "?") out.to = toMatch[1];

  const codeMatch = detail.match(/\bcode=(\d+)/);
  if (codeMatch) out.code = Number(codeMatch[1]);

  // Título = lo que hay entre "code=<n> " y " :: " (puede faltar cualquiera).
  const afterCode = detail.match(/\bcode=\S+\s+([^]*)$/);
  if (afterCode) {
    const tail = afterCode[1];
    const sep = tail.indexOf(" :: ");
    if (sep >= 0) {
      out.title = tail.slice(0, sep).trim();
      out.rest = tail.slice(sep + 4).trim();
    } else {
      out.title = tail.trim();
    }
  }
  return out;
}

/**
 * Código de error de Meta → etiqueta humana para la card. Solo los códigos que
 * este negocio ya vio o puede ver; el resto cae al default con el número visible
 * (para poder googlearlo / pegarlo a Claude).
 */
export function metaCodeLabel(code: number | null | undefined): string {
  switch (code) {
    case 131047:
      return "Ventana de 24h cerrada (re-engagement sin template)";
    case 131026:
      return "No entregable (número sin WhatsApp o bloqueó al negocio)";
    case 131042:
      return "Problema de facturación de la cuenta (billing)";
    case 131048:
      return "Límite de envíos por reportes de spam";
    case 132012:
      return "Parámetros del template no coinciden";
    case 132015:
      return "Template pausado o deshabilitado";
    case 132000:
      return "Template inexistente o no aprobado";
    case 100:
      return "Parámetro inválido en el envío";
    case null:
    case undefined:
      return "Error de Meta (sin código)";
    default:
      return `Error de Meta (código ${code})`;
  }
}

export type FailedRuleClass =
  | "guest_operational"
  | "staff_operational"
  | "reengagement"
  | "other";

const GUEST_SET: ReadonlySet<string> = new Set(GUEST_OPERATIONAL_RULES);
const STAFF_SET: ReadonlySet<string> = new Set(STAFF_OPERATIONAL_RULES);
const REENGAGEMENT_RULES: ReadonlySet<string> = new Set([
  "auto_followup",
  "last_call",
  "manual_inbox",
]);

/**
 * Clase del fallo según la regla del mensaje. El watchdog decide con esto:
 * guest_operational → alerta SIEMPRE (el huésped se quedó sin instrucciones);
 * reengagement → NO alerta solo (típico 131047 fuera de ventana, es esperable);
 * todo cuenta para la ráfaga sistémica.
 */
export function classifyFailedRule(rule: string | null | undefined): FailedRuleClass {
  if (!rule) return "other";
  if (GUEST_SET.has(rule)) return "guest_operational";
  if (STAFF_SET.has(rule)) return "staff_operational";
  if (REENGAGEMENT_RULES.has(rule)) return "reengagement";
  return "other";
}
