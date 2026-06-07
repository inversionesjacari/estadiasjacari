/// <reference types="@cloudflare/workers-types" />
//
// Bot conversacional para Estadías Jacarí — Option B.
//
// Maneja DOS responsabilidades en UNA sola llamada a Workers AI (Llama 3.3):
//   1. Responde preguntas sobre las propiedades (piscina, playa, mascotas, etc.)
//      usando la base de conocimiento de property-kb.ts
//   2. Extrae datos de cotización del mensaje (fechas, huéspedes, propiedad)
//
// Ventaja: un solo request = respuesta natural + datos estructurados.
//
// Fallback: si Workers AI no está disponible (binding no configurado),
//   devuelve ok:false para que quote-flow.ts pueda escalar a humano.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { PROPERTY_KNOWLEDGE_BASE } from "./property-kb";
import { callWorkersAIJson, type WorkersAIEnv } from "./workers-ai";

// Re-export so callers can import WorkersAIEnv from here or from workers-ai directly
export type { WorkersAIEnv };
import type { QuoteData, PropertySlug, City } from "./quote-extractor";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export type BotIntent =
  | "providing_data"   // el huésped dio fechas/personas/propiedad
  | "asking_question"  // pregunta sobre propiedades/servicios
  | "confirming"       // "sí, dale, perfecto" → acepta algo
  | "rejecting"        // "no, cancelo, no quiero"
  | "unknown";         // no se puede clasificar

export interface ConversationalResponse {
  ok: boolean;
  /** Texto natural para enviar al huésped por WhatsApp. */
  reply: string;
  /** Datos extraídos del mensaje (campos que no se conocían o actualizaron). */
  extractedData: Partial<QuoteData>;
  /** Intención del mensaje. */
  intent: BotIntent;
  /** Tokens consumidos (para auditing). */
  tokensUsed: number;
  /** Mensaje de error si ok=false. */
  error?: string;
}

// Schema que debe retornar el modelo
interface LlamaOutput {
  reply: string;
  checkIn: string | null;
  checkOut: string | null;
  guests: number | null;
  property: string | null;
  city: string | null;
  intent: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación de slugs y ciudades
// ─────────────────────────────────────────────────────────────────────────────

const VALID_PROPERTIES: PropertySlug[] = [
  "villa-b11-palma-real",
  "casa-brisa",
  "casa-marea",
  "centro-morazan",
  "casa-lara-townhouse",
  "la-florida",
];

const VALID_CITIES: City[] = ["La Ceiba", "Tela", "Tegucigalpa"];

const VALID_INTENTS: BotIntent[] = [
  "providing_data",
  "asking_question",
  "confirming",
  "rejecting",
  "unknown",
];

// ─────────────────────────────────────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Procesa un mensaje del huésped con el bot conversacional.
 *
 * @param userMessage  El texto que acaba de mandar el huésped.
 * @param previousData Datos de cotización que ya teníamos (floor para el merge).
 * @param todayIso     Fecha de hoy en YYYY-MM-DD (Honduras, GMT-6).
 * @param env          Env con binding AI (Workers AI).
 */
export async function runConversationalBot(
  userMessage: string,
  previousData: QuoteData,
  todayIso: string,
  env: WorkersAIEnv,
): Promise<ConversationalResponse> {
  const systemPrompt = buildSystemPrompt(todayIso);
  const userPrompt   = buildUserPrompt(userMessage, previousData);

  const result = await callWorkersAIJson<LlamaOutput>(
    [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
    env,
    { temperature: 0.15, maxTokens: 600 },
  );

  if (!result.ok || !result.data) {
    return {
      ok:            false,
      reply:         "Disculpa, tuve un problema técnico procesando tu mensaje. Un agente humano te responde en breve. 🙏",
      extractedData: {},
      intent:        "unknown",
      tokensUsed:    result.tokensUsed,
      error:         result.error,
    };
  }

  const d = result.data;

  // ── Validar y sanitizar el output del modelo ───────────────────────────────
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;

  const property =
    d.property && VALID_PROPERTIES.includes(d.property as PropertySlug)
      ? (d.property as PropertySlug)
      : null;

  const city =
    d.city && VALID_CITIES.includes(d.city as City)
      ? (d.city as City)
      : null;

  const checkIn =
    typeof d.checkIn === "string" && isoDate.test(d.checkIn) ? d.checkIn : null;

  const checkOut =
    typeof d.checkOut === "string" && isoDate.test(d.checkOut) ? d.checkOut : null;

  const guests =
    typeof d.guests === "number" && d.guests > 0 && d.guests <= 20
      ? Math.round(d.guests)
      : null;

  const intent: BotIntent = VALID_INTENTS.includes(d.intent as BotIntent)
    ? (d.intent as BotIntent)
    : "unknown";

  // Reply con fallback por si el modelo devolvió string vacío
  const reply =
    typeof d.reply === "string" && d.reply.trim().length > 0
      ? d.reply.trim()
      : "¡Hola! ¿En qué te puedo ayudar hoy? 🌴";

  return {
    ok:            true,
    reply,
    extractedData: { checkIn, checkOut, guests, property, city },
    intent,
    tokensUsed:    result.tokensUsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Construcción de prompts
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(todayIso: string): string {
  return `Eres el asistente virtual de *Estadías Jacarí*, empresa hondureña de alquileres turísticos. Atiendes consultas de clientes potenciales vía WhatsApp.
Hoy es ${todayIso} (zona horaria Honduras, GMT-6).

${PROPERTY_KNOWLEDGE_BASE}

---

## TUS REGLAS

### Cómo responder
1. Responde en *español informal pero respetuoso*, el mismo tono del mensaje del cliente.
2. Sé breve y directo — esto es WhatsApp, no un email.
3. Usa emojis con moderación (1-2 por mensaje máximo).
4. Si la pregunta tiene respuesta en la base de conocimiento → respóndela directamente.
5. Si la información dice "[PENDIENTE]" → di "eso te lo confirmo en un momento con el equipo".
6. NUNCA inventes precios ni disponibilidad. Para precios, di que los calculas cuando tengas las fechas y huéspedes.
7. NUNCA digas que eres una IA. Eres el asistente de Estadías Jacarí.

### Extraer datos de cotización
Si el cliente menciona fechas o número de personas:
- checkIn / checkOut: convertir a YYYY-MM-DD. Interpretar relativo a hoy (${todayIso}).
  - "este fin de semana" = próximo viernes y domingo
  - "el 15" sin mes = próximo día 15 desde hoy
  - "próximas vacaciones de semana santa" → preguntar año/fechas exactas
- guests: número total (adultos + niños). "somos 2 adultos y 1 niño" → guests: 3
- property: slug exacto (ver lista abajo). Si dicen la ciudad pero no la propiedad → city, property: null
- city: solo si mencionaron una ciudad sin especificar propiedad

### Slugs válidos (úsalos exactamente así)
- "villa-b11-palma-real"   → Villa B11 (La Ceiba)
- "casa-brisa"             → Casa Brisa / La Casita del Mar (Tela)
- "casa-marea"             → Casa Marea / Tela Beach House (Tela)
- "centro-morazan"         → Centro Morazán (Tegucigalpa)
- "casa-lara-townhouse"    → Casa Lara Townhouse (Tegucigalpa)
- "la-florida"             → La Florida (Tegucigalpa)

### Orden de prioridad para pedir datos
Si no sabés aún con qué propiedad quiere el huésped, eso es LO PRIMERO que preguntás — antes de pedir fechas o número de huéspedes. Sin saber la propiedad no podés responder preguntas sobre piscina, playa, camas, etc. correctamente.

Ejemplo: si alguien pregunta "¿hay piscina?" y no sabemos la propiedad → respondé: "¡Con gusto te ayudo! ¿De cuál de nuestras propiedades me estás escribiendo? 🏡" y listar las opciones según la ciudad si la mencionaron.

Una vez que sabés la propiedad, respondés todo específicamente para esa propiedad.

Si ya sabemos la propiedad (está en los datos previos), NO la volvás a preguntar.

### Si te preguntan por precio
Primero confirmá la propiedad (si no está en los datos previos), luego pedí las fechas y el número de huéspedes. Hacélo de forma conversacional, no como un formulario.

### Intención del mensaje
Clasifica el mensaje en uno de estos:
- "providing_data"   → está dando fechas, personas o eligiendo propiedad
- "asking_question"  → pregunta sobre amenidades, políticas, ubicación, etc.
- "confirming"       → acepta algo (sí, dale, perfecto, de acuerdo, listo)
- "rejecting"        → rechaza algo (no, cancelo, no gracias)
- "unknown"          → no se puede clasificar claramente

---

## FORMATO DE RESPUESTA (obligatorio)

Responde ÚNICAMENTE con este JSON exacto, sin texto adicional antes ni después, sin markdown:

{
  "reply": "Tu respuesta en español para el cliente",
  "checkIn": "YYYY-MM-DD o null",
  "checkOut": "YYYY-MM-DD o null",
  "guests": número_entero_o_null,
  "property": "slug-exacto o null",
  "city": "La Ceiba" | "Tela" | "Tegucigalpa" | null,
  "intent": "providing_data" | "asking_question" | "confirming" | "rejecting" | "unknown"
}`;
}

function buildUserPrompt(userMessage: string, previousData: QuoteData): string {
  // Solo incluir los datos previos si hay al menos uno no-null
  const hasContext =
    previousData.checkIn ||
    previousData.checkOut ||
    previousData.guests ||
    previousData.property ||
    previousData.city;

  const contextBlock = hasContext
    ? `\n\nDatos que ya tenemos del cliente (no los repitas en la respuesta a menos que sea relevante confirmarlos):
checkIn: ${previousData.checkIn ?? "desconocido"}
checkOut: ${previousData.checkOut ?? "desconocido"}
guests: ${previousData.guests ?? "desconocido"}
property: ${previousData.property ?? "desconocida"}
city: ${previousData.city ?? "desconocida"}`
    : "";

  return `Mensaje del cliente: "${userMessage}"${contextBlock}

Genera la respuesta y extrae los datos en el JSON indicado.`;
}
