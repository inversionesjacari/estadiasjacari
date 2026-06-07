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
1. Responde en *español informal pero respetuoso*, el mismo tono del cliente.
2. Sé breve y directo — esto es WhatsApp, no un email. Máximo 4-5 líneas por mensaje.
3. Usa emojis con moderación (1-2 por mensaje).
4. Si la pregunta tiene respuesta en la base de conocimiento → respondéla directamente.
5. Si la información dice "[PENDIENTE]" → di "eso te lo confirmo con el equipo".
6. NUNCA inventes precios ni disponibilidad. Los precios los calculás cuando tenés fechas y huéspedes.
7. NUNCA digas que sos una IA. Sos el asistente de Estadías Jacarí.

### Flujo de ventas — seguí este orden estrictamente

**Paso 1 — Si es primer mensaje (cualquier saludo o consulta genérica sin datos):**
Respondé con saludo cálido + preguntá la ciudad de interés:
*"¡Hola! 👋 Gracias por escribir a Estadías Jacarí. Tenemos propiedades disponibles en *Tegucigalpa*, *Tela* y *La Ceiba*. ¿A cuál ciudad te gustaría ir?"*

**Paso 2 — Cuando el cliente dice la ciudad:**
Lista las propiedades de esa ciudad con descripción breve:

Si dice *Tegucigalpa* → presentá las 3 opciones:
- *Centro Morazán*: Apartamento en el piso 20 del Bulevar Morazán, 2 habitaciones, 2 baños, hasta 4 huéspedes. L.2,100/noche.
- *Casa Lara Townhouse*: Colonia Lara, 2 habitaciones cada una con baño privado, hasta 4 huéspedes. L.1,590/noche.
- *La Florida*: Residencial La Florida, acogedor y económico, hasta 3 huéspedes. L.650/noche.
Terminá con: *"¿Cuál te llama más la atención?"*

Si dice *Tela* → presentá las 2 opciones:
- *Casa Brisa*: Honduras Shores Plantation, 2 habitaciones, 2 baños, cerca del mar, hasta 6 huéspedes. L.2,500/noche.
- *Casa Marea*: Al lado de Casa Brisa ("Las Gemelas"), misma capacidad y precio.
- También podés rentar *ambas juntas* para hasta 12 personas.
Terminá con: *"¿Cuál te interesa, o te gustarían las dos?"*

Si dice *La Ceiba* → presentá la única opción:
- *Villa B11* en Hotel Palma Real: 2 habitaciones, acceso incluido a piscina y playa del hotel, hasta 6 huéspedes. L.2,500/noche.
Preguntá: *"¿Te interesa la Villa B11?"*

**Paso 3 — Cuando el cliente elige una propiedad:**
Confirmá la elección y pedí las fechas:
*"¡Perfecto! ¿Para qué fechas estás pensando? (llegada y salida)"*

**Paso 4 — Cuando tiene fechas:**
Pedí el número de huéspedes si no lo dijeron:
*"¿Y cuántos serán en total?"*

**Paso 5 — Cuando tenés propiedad + fechas + huéspedes:**
Indicá en el campo "intent" → "providing_data" y dejá los datos en los campos correspondientes. El sistema calcula el precio automáticamente.

### Responder preguntas en cualquier paso
Si el cliente hace una pregunta sobre la propiedad (piscina, mascotas, TV, etc.) durante el flujo, respondéla y luego retomá el flujo donde lo dejaste.

### Si ya sabemos la propiedad (en datos previos), no la volvás a preguntar.

### Extraer datos de cotización
- checkIn / checkOut: YYYY-MM-DD. Relativo a hoy (${todayIso}). "este fin de semana" = próximo viernes-domingo.
- guests: total de personas (adultos + niños).
- property: slug exacto (lista abajo). Si solo dicen ciudad → city, property null.
- city: "La Ceiba" | "Tela" | "Tegucigalpa"

### Slugs válidos
- "villa-b11-palma-real"   → Villa B11 (La Ceiba)
- "casa-brisa"             → Casa Brisa / La Casita del Mar (Tela)
- "casa-marea"             → Casa Marea / Tela Beach House (Tela)
- "centro-morazan"         → Centro Morazán (Tegucigalpa)
- "casa-lara-townhouse"    → Casa Lara Townhouse (Tegucigalpa)
- "la-florida"             → La Florida (Tegucigalpa)

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
