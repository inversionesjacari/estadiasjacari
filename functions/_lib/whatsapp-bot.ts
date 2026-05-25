/// <reference types="@cloudflare/workers-types" />
//
// Bot WhatsApp inbound — rule-based, sin LLM.
//
// Recibe el texto del huésped y devuelve { reply, ruleName } si alguna regla
// matcheó, o null si hay que escalar a César.
//
// Las reglas son funciones puras que reciben:
//   - texto normalizado (lowercase, sin acentos)
//   - info de check-in de la propiedad (WiFi, accesos, contacto local, etc.)
//   - datos básicos de la reserva (nombre, fechas, propiedad)
//
// Identificación: dado el teléfono entrante, buscamos en `reservations` una
// reserva activa (status confirmed/pending, ventana relevante check_in ±1 día
// hasta check_out +1 día). Si NO encontramos reserva, el bot responde con un
// mensaje genérico y escala. No queremos responder con info de check-in a un
// número aleatorio.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import type { CheckinInfo } from "./checkin-info";

const WHATSAPP_CESAR_PERSONAL = "50497649035";
const WHATSAPP_JACARI = "50488390145";

export interface ActiveReservation {
  id: number;
  property_slug: string;
  check_in: string;   // YYYY-MM-DD
  check_out: string;  // YYYY-MM-DD
  guest_name: string | null;
  guest_email: string | null;
  guest_phone_normalized: string | null;
}

export interface BotContext {
  /** Reserva activa del huésped (null si no encontramos ninguna). */
  reservation: ActiveReservation | null;
  /** Info de check-in cargada del Sheet (WiFi, llaves, contacto local, etc.). */
  info: CheckinInfo | null;
  /** Fecha de hoy en Honduras (YYYY-MM-DD), inyectada para testabilidad. */
  todayHn: string;
}

export interface BotReply {
  /** Texto a enviar al huésped (≤4096 chars Meta limit). */
  reply: string;
  /** Nombre corto de la regla que matcheó — útil para log + analytics. */
  ruleName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalización de texto (lowercase + sin acentos + colapsar espacios)
// ─────────────────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita acentos
    .replace(/[¿¡]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Match si CUALQUIER patrón está como substring del texto normalizado. */
function anyMatch(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.includes(p));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reglas individuales — devuelven string si matchearon, null si no
// ─────────────────────────────────────────────────────────────────────────────

function ruleSaludoCortes(text: string, _ctx: BotContext): string | null {
  // Mensajes cortos de cortesía que no requieren respuesta sustantiva
  if (!anyMatch(text, ["gracias", "muchas gracias", "ok", "perfecto", "listo", "entendido"])) return null;
  // Solo si el mensaje es CORTO — "gracias por el wifi" debe matchear wifi, no esto
  if (text.length > 30) return null;
  return "¡De nada! 🙂 Si necesitas algo más, estoy aquí.";
}

function ruleEscalarHumano(text: string, _ctx: BotContext): string | null {
  if (!anyMatch(text, ["humano", "persona", "agente", "real", "hablar con cesar", "hablar con alguien"])) return null;
  // Devolvemos un marcador especial — el webhook lo trata como escalation manual
  return `__ESCALATE__`;
}

function ruleWifi(text: string, ctx: BotContext): string | null {
  if (!anyMatch(text, ["wifi", "wi-fi", "internet", "red", "contrasena", "contraseña", "clave"])) return null;
  if (!ctx.info) return null;
  const net = ctx.info.wifiNetwork;
  const pass = ctx.info.wifiPassword;
  if (!net && !pass) {
    return `Ahorita no tengo el WiFi en mis registros. Te conecto con un agente humano para que te lo dé.\n\n__ESCALATE__`;
  }
  const parts: string[] = ["📶 *WiFi de la propiedad*"];
  if (net) parts.push(`Red: *${net}*`);
  if (pass) parts.push(`Contraseña: *${pass}*`);
  parts.push("\n¿Algo más en lo que te pueda ayudar?");
  return parts.join("\n");
}

function ruleLlaves(text: string, ctx: BotContext): string | null {
  if (!anyMatch(text, ["llave", "llaves", "acceso", "entrar", "puerta", "codigo", "código", "lockbox", "caja de seguridad"])) return null;
  if (!ctx.info?.accessInstructions) {
    return `Ahorita no tengo las instrucciones de acceso en mis registros. Te conecto con un agente humano.\n\n__ESCALATE__`;
  }
  return `🔑 *Cómo entrar a la propiedad*\n\n${ctx.info.accessInstructions}\n\n¿Algo más?`;
}

function ruleComoLlegar(text: string, ctx: BotContext): string | null {
  if (!anyMatch(text, ["como llegar", "direccion", "dirección", "ubicacion", "ubicación", "maps", "google maps", "donde queda", "donde esta", "mapa"])) return null;
  if (!ctx.info?.arrivalInstructions) {
    return `Ahorita no tengo las instrucciones de llegada en mis registros. Te conecto con un agente humano.\n\n__ESCALATE__`;
  }
  // Resumir si es muy largo (Meta max 4096 chars total, dejar margen)
  const arr = ctx.info.arrivalInstructions;
  const body = arr.length > 1500 ? arr.slice(0, 1500) + "...\n\n(Te envío el resto por separado si lo necesitas — solo dime *más*)" : arr;
  return `📍 *Cómo llegar*\n\n${body}\n\n¿Te ayudo con algo más?`;
}

function ruleCheckIn(text: string, ctx: BotContext): string | null {
  if (!anyMatch(text, ["check in", "checkin", "check-in", "llegada", "entrada", "a que hora puedo llegar", "hora de entrada"])) return null;
  if (!ctx.reservation) return null;
  return `📅 *Tu check-in*\n\nFecha: ${formatDateEs(ctx.reservation.check_in)}\nHora de entrada: *3:00 PM* (hora Honduras)\n\nSi llegas antes, podemos coordinar — solo avísanos.`;
}

function ruleCheckOut(text: string, ctx: BotContext): string | null {
  if (!anyMatch(text, ["check out", "checkout", "check-out", "salida", "a que hora me voy", "hora de salida"])) return null;
  if (!ctx.reservation) return null;
  return `📅 *Tu check-out*\n\nFecha: ${formatDateEs(ctx.reservation.check_out)}\nHora de salida: *11:00 AM* (hora Honduras)\n\nSi necesitas late check-out, escríbenos con tiempo y vemos disponibilidad.`;
}

function ruleHorarios(text: string, _ctx: BotContext): string | null {
  if (!anyMatch(text, ["horario", "a que hora", "que hora", "que horario"])) return null;
  return `🕒 *Horarios*\n\n• Check-in: *3:00 PM*\n• Check-out: *11:00 AM*\n\n(Hora Honduras)`;
}

function ruleContactoLocal(text: string, ctx: BotContext): string | null {
  if (!anyMatch(text, ["contacto", "emergencia", "urgente", "ayuda local", "quien me ayuda"])) return null;
  const name = ctx.info?.localContactName;
  const tel = ctx.info?.localContactPhone;
  if (!name && !tel) {
    return `Si tienes una urgencia, escríbeme aquí mismo o llama al WhatsApp principal: +504 8839-0145. Si necesitas atención inmediata en sitio, te conecto con un agente.\n\n__ESCALATE__`;
  }
  const parts: string[] = ["📞 *Tu contacto local*"];
  if (name) parts.push(`Nombre: *${name}*`);
  if (tel) parts.push(`Teléfono: *${tel}*`);
  parts.push("\nSi no responde, escríbenos aquí y te ayudamos.");
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline: orden importa — reglas más específicas primero
// ─────────────────────────────────────────────────────────────────────────────

const RULES: Array<{ name: string; fn: (text: string, ctx: BotContext) => string | null }> = [
  { name: "escalar_humano",   fn: ruleEscalarHumano },
  { name: "wifi",             fn: ruleWifi },
  { name: "llaves",           fn: ruleLlaves },
  { name: "como_llegar",      fn: ruleComoLlegar },
  { name: "check_in",         fn: ruleCheckIn },
  { name: "check_out",        fn: ruleCheckOut },
  { name: "horarios",         fn: ruleHorarios },
  { name: "contacto_local",   fn: ruleContactoLocal },
  { name: "saludo_cortes",    fn: ruleSaludoCortes },
];

/**
 * Aplica las reglas en orden. Devuelve la primera que matchee, o null para escalar.
 * Si la regla devuelve un texto que contiene `__ESCALATE__`, el caller debe
 * tratar el mensaje como escalación además de enviarlo.
 */
export function matchBotRule(text: string, ctx: BotContext): BotReply | null {
  const norm = normalize(text);
  for (const rule of RULES) {
    const reply = rule.fn(norm, ctx);
    if (reply !== null) {
      return { reply, ruleName: rule.name };
    }
  }
  return null;
}

/**
 * Mensaje de fallback cuando ninguna regla matcheó. Se acompaña SIEMPRE de
 * una escalación por email a César.
 */
export function buildEscalationReply(ctx: BotContext): string {
  if (ctx.reservation) {
    return `Recibimos tu mensaje. Te estoy conectando con un agente humano que te va a responder por este mismo chat. Si es urgente, llama al WhatsApp +504 8839-0145.`;
  }
  return `¡Hola! Gracias por escribir a Estadías Jacarí. No te encuentro como huésped activo en este momento. Si quieres reservar visita https://estadiasjacari.com o escribe a hola@estadiasjacari.com. Si tienes una consulta general, un agente te responderá pronto por este chat.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// findActiveReservation — busca reserva relevante por teléfono
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca una reserva activa para el número entrante.
 *
 * Criterios:
 *   - guest_phone_normalized = phoneE164 (E.164 sin '+')
 *   - status IN ('confirmed', 'pending')
 *   - check_in <= today + 1 día (huésped ya llegó o llega mañana)
 *   - check_out >= today - 1 día (huésped sigue dentro o salió ayer)
 *
 * Si hay varias matches (raro), devuelve la más reciente por check_in DESC.
 */
export async function findActiveReservation(
  phoneE164: string,
  db: D1Database,
  todayHn: string,
): Promise<ActiveReservation | null> {
  const [y, m, d] = todayHn.split("-").map(Number);
  if (!y || !m || !d) return null;
  const today = new Date(Date.UTC(y, m - 1, d));
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const ymd = (date: Date) => date.toISOString().slice(0, 10);

  const row = await db
    .prepare(
      `SELECT id, property_slug, check_in, check_out, guest_name, guest_email, guest_phone_normalized
         FROM reservations
        WHERE guest_phone_normalized = ?
          AND status IN ('confirmed', 'pending')
          AND check_in <= ?
          AND check_out >= ?
        ORDER BY check_in DESC
        LIMIT 1`,
    )
    .bind(phoneE164, ymd(tomorrow), ymd(yesterday))
    .first<ActiveReservation>();

  return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper local (replicado de email.ts / checkin-email.ts para no acoplar)
// ─────────────────────────────────────────────────────────────────────────────

const FMT_MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function formatDateEs(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} de ${FMT_MONTHS_ES[m - 1]} de ${y}`;
}

// Re-exports para que los tests externos puedan importarlas
export const __testing__ = { normalize, anyMatch };
export { WHATSAPP_CESAR_PERSONAL, WHATSAPP_JACARI };
