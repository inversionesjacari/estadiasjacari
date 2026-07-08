//
// llm-schema.ts — Validación del output del LLM (plan maestro 4.1 / pista bot B1).
//
// El bot conversacional le pide al modelo un JSON con { reply, checkIn, checkOut,
// guests, property, city, intent, language }. Los modelos a veces devuelven ese
// JSON roto: sin reply, con slugs inventados, fechas en otro formato, intents que
// no existen. Antes esa sanitización vivía inline en conversational-bot.ts; acá
// queda centralizada y TESTEABLE, y además distingue "usable" de "hay que
// reintentar":
//
//   - ok=true  → el output tiene la forma mínima usable (objeto con reply de texto).
//     Los campos secundarios inválidos se anulan en silencio (igual que siempre)
//     pero quedan anotados en `problems` para bot_trace.
//   - ok=false → el output NO sirve para responder (no es objeto / reply vacío).
//     El caller reintenta 1× y, si sigue roto, cae al fallback determinístico.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import type { PropertySlug, City } from "./quote-extractor";
import type { BotIntent } from "./conversational-bot";

const VALID_PROPERTIES: PropertySlug[] = [
  "villa-b11-palma-real",
  "casa-brisa",
  "casa-marea",
  "centro-morazan",
  "casa-lara-townhouse",
  "la-florida",
  "las-gemelas-tela",
];

const VALID_CITIES: City[] = ["La Ceiba", "Tela", "Tegucigalpa"];

const VALID_INTENTS: BotIntent[] = [
  "providing_data",
  "asking_question",
  "requesting_photos",
  "confirming",
  "rejecting",
  "existing_guest",
  "out_of_scope",
  "unknown",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Campos del output del modelo ya sanitizados (inválido → null / default seguro). */
export interface BotFields {
  /** null = el modelo no dio un reply usable (string no vacío). */
  reply: string | null;
  checkIn: string | null;
  checkOut: string | null;
  guests: number | null;
  property: PropertySlug | null;
  city: City | null;
  intent: BotIntent;
  language: "es" | "en";
}

export interface SchemaCheck {
  /** true = forma mínima usable (objeto con reply de texto no vacío). */
  ok: boolean;
  /** Qué estaba roto, para bot_trace y diagnóstico. Vacío si todo vino bien. */
  problems: string[];
  fields: BotFields;
}

const EMPTY_FIELDS: BotFields = {
  reply: null,
  checkIn: null,
  checkOut: null,
  guests: null,
  property: null,
  city: null,
  intent: "unknown",
  language: "es",
};

/**
 * Valida y sanitiza el JSON que devolvió el modelo. Nunca throws.
 * Misma semántica que la sanitización histórica de conversational-bot.ts:
 * un campo secundario inválido se anula (no invalida el mensaje); solo la
 * FALTA de reply (o un output que no es objeto) marca ok=false.
 */
export function validateBotOutput(raw: unknown): SchemaCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      problems: [`output no es un objeto JSON (${Array.isArray(raw) ? "array" : typeof raw})`],
      fields: { ...EMPTY_FIELDS },
    };
  }

  const d = raw as Record<string, unknown>;
  const problems: string[] = [];

  const reply =
    typeof d.reply === "string" && d.reply.trim().length > 0 ? d.reply.trim() : null;
  if (reply === null) problems.push("reply vacío o ausente");

  const property =
    typeof d.property === "string" && VALID_PROPERTIES.includes(d.property as PropertySlug)
      ? (d.property as PropertySlug)
      : null;
  if (d.property != null && property === null) {
    problems.push(`property inválida: ${String(d.property).slice(0, 60)}`);
  }

  const city =
    typeof d.city === "string" && VALID_CITIES.includes(d.city as City)
      ? (d.city as City)
      : null;
  if (d.city != null && city === null) {
    problems.push(`city inválida: ${String(d.city).slice(0, 60)}`);
  }

  const checkIn =
    typeof d.checkIn === "string" && ISO_DATE.test(d.checkIn) ? d.checkIn : null;
  if (d.checkIn != null && checkIn === null) {
    problems.push(`checkIn no-ISO: ${String(d.checkIn).slice(0, 30)}`);
  }

  const checkOut =
    typeof d.checkOut === "string" && ISO_DATE.test(d.checkOut) ? d.checkOut : null;
  if (d.checkOut != null && checkOut === null) {
    problems.push(`checkOut no-ISO: ${String(d.checkOut).slice(0, 30)}`);
  }

  const guests =
    typeof d.guests === "number" && d.guests > 0 && d.guests <= 20
      ? Math.round(d.guests)
      : null;
  if (d.guests != null && guests === null) {
    problems.push(`guests fuera de rango: ${String(d.guests).slice(0, 20)}`);
  }

  const intent: BotIntent = VALID_INTENTS.includes(d.intent as BotIntent)
    ? (d.intent as BotIntent)
    : "unknown";
  if (d.intent != null && !VALID_INTENTS.includes(d.intent as BotIntent)) {
    problems.push(`intent desconocido: ${String(d.intent).slice(0, 40)}`);
  }

  const language: "es" | "en" = d.language === "en" ? "en" : "es";

  return {
    ok: reply !== null,
    problems,
    fields: { reply, checkIn, checkOut, guests, property, city, intent, language },
  };
}
