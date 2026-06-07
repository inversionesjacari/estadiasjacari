/// <reference types="@cloudflare/workers-types" />
//
// Extractor de datos de cotización — usa Claude Haiku para parsear mensajes
// del huésped en lenguaje natural y obtener:
//   - fechas check-in / check-out (YYYY-MM-DD)
//   - cantidad de huéspedes
//   - propiedad o ciudad de interés
//
// Diseñado para ser idempotente: recibe lo que ya sabemos del estado previo
// y devuelve la versión actualizada. Si el huésped no aporta nuevo dato, los
// campos del input se preservan.
//
// Modelo: claude-haiku-4-5 (rápido, barato, suficiente para extracción).
//
// Costo aprox: $0.0005 por extracción. Para 100 leads/mes × 3 msgs = $0.15/mes.
//

import { callClaudeJson, type AnthropicEnv } from "./anthropic";

export type PropertySlug =
  | "villa-b11-palma-real"
  | "casa-brisa"
  | "casa-marea"
  | "centro-morazan"
  | "casa-lara-townhouse"
  | "la-florida";

export type City = "La Ceiba" | "Tela" | "Tegucigalpa";

export interface QuoteData {
  /** Check-in YYYY-MM-DD. null si no se conoce. */
  checkIn: string | null;
  /** Check-out YYYY-MM-DD. null si no se conoce. */
  checkOut: string | null;
  /** Cantidad de huéspedes. null si no se conoce. */
  guests: number | null;
  /** Propiedad específica (slug). null si solo se sabe la ciudad o nada. */
  property: PropertySlug | null;
  /** Ciudad si la mencionó (ayuda a desambiguar entre las 2 props de Tela). */
  city: City | null;
  /** Order ID de PayPal (set una vez que el bot generó el link). */
  paypalOrderId?: string | null;
  /** Monto del 50% que se pidió (USD). Para reconstruir al recibir webhook. */
  depositUsd?: number | null;
}

export interface ExtractionResult {
  ok: boolean;
  /** Datos actualizados — siempre incluye los campos viejos como floor. */
  data?: QuoteData;
  /** Si Claude reconoció una intención específica del mensaje. */
  intent?:
    | "providing_data"  // está dando fechas/huéspedes/propiedad
    | "asking_question" // pregunta general no relacionada
    | "confirming"      // dice sí/de acuerdo/perfecto a una cotización
    | "rejecting"       // dice no/cancelar/no me sirve
    | "unknown";
  error?: string;
  /** Tokens consumidos (para auditing/costos). */
  tokensUsed?: number;
}

/** Lista de propiedades para que Claude sepa qué slugs son válidos. */
const PROPERTIES_REFERENCE = `
Propiedades disponibles (cada una tiene su slug):
- "villa-b11-palma-real"   → Villa B11 en Hotel Palma Real, La Ceiba (6 huéspedes)
- "casa-brisa"             → Casa Brisa (también llamada La Casita del Mar) en Honduras Shores Plantation, Tela (6 huéspedes)
- "casa-marea"             → Casa Marea (también llamada Tela Beach House) en Honduras Shores Plantation, Tela (6 huéspedes)
- "centro-morazan"         → Apartamento en Centro Morazán, Tegucigalpa (4 huéspedes)
- "casa-lara-townhouse"    → Townhouse en Colonia Lara, Tegucigalpa (4 huéspedes)
- "la-florida"             → Casa en La Florida, Tegucigalpa (3 huéspedes)

Casa Brisa y Casa Marea están una al lado de la otra ("Las Gemelas") y se pueden alquilar juntas para grupos de hasta 12.
`.trim();

/**
 * Extrae/actualiza los datos de cotización del último mensaje del huésped.
 *
 * @param userMessage  El mensaje en lenguaje natural que acaba de mandar.
 * @param previousData Lo que ya teníamos del huésped (puede ser todo null).
 * @param todayIso     Fecha de hoy (YYYY-MM-DD) — para que Claude entienda
 *                     fechas relativas como "este fin de semana" o "del 15".
 * @param env          Env con ANTHROPIC_API_KEY.
 */
export async function extractQuoteData(
  userMessage: string,
  previousData: QuoteData,
  todayIso: string,
  env: AnthropicEnv,
): Promise<ExtractionResult> {
  const system = `Eres un asistente de Estadías Jacarí, una empresa de alquileres temporales en Honduras. Tu trabajo es extraer información estructurada de mensajes de huéspedes que están solicitando una cotización.

${PROPERTIES_REFERENCE}

Hoy es ${todayIso} (Honduras, GMT-6).

Tu trabajo: dado un mensaje del huésped, extraer y actualizar los siguientes campos. Si el huésped NO menciona un campo en este mensaje, mantén el valor previo (no lo borres).

Campos a extraer:
- checkIn: fecha de llegada en formato YYYY-MM-DD. Interpreta fechas relativas con respecto a hoy.
- checkOut: fecha de salida en formato YYYY-MM-DD. Si dice "3 noches" sin fecha exacta, calcula desde checkIn.
- guests: número total de huéspedes (incluye adultos + niños).
- property: slug exacto de la propiedad (de la lista). null si solo mencionó ciudad sin propiedad específica.
- city: "La Ceiba" | "Tela" | "Tegucigalpa". Si se menciona una ciudad sin propiedad específica.
- intent: clasifica el mensaje en una de estas categorías:
  * "providing_data" — está dando fechas, número de huéspedes, o propiedad
  * "asking_question" — pregunta algo no relacionado con datos de cotización
  * "confirming" — dice sí, perfecto, de acuerdo a algo
  * "rejecting" — dice no, cancelar, no quiero
  * "unknown" — no se puede clasificar claramente

Reglas importantes:
- Si una fecha es ambigua (ej. "el 15" sin mes), asume el próximo 15 desde hoy.
- "Este fin de semana" = próximo viernes a domingo desde hoy.
- "Nochebuena" = 24 de diciembre del año en curso o el próximo.
- Si el huésped dice "para 2 personas y 1 niño" → guests = 3 (todos cuentan).
- Si menciona "Tela" sin propiedad específica → city = "Tela", property = null.
- Si menciona "Casa Brisa" → property = "casa-brisa", city = "Tela".
- Si menciona "La Casita del Mar" → es Casa Brisa (alias) → property = "casa-brisa".
- Si menciona "Tela Beach House" → es Casa Marea (alias) → property = "casa-marea".
- Si menciona "Villa B11" o "Palma Real" → property = "villa-b11-palma-real", city = "La Ceiba".

Devuelve SOLO un JSON con esta forma exacta, sin markdown ni explicaciones:
{
  "checkIn": "YYYY-MM-DD" | null,
  "checkOut": "YYYY-MM-DD" | null,
  "guests": number | null,
  "property": "slug-exacto" | null,
  "city": "La Ceiba" | "Tela" | "Tegucigalpa" | null,
  "intent": "providing_data" | "asking_question" | "confirming" | "rejecting" | "unknown"
}`;

  const userPrompt = `Datos previos del huésped (lo que ya sabemos):
${JSON.stringify(previousData, null, 2)}

Mensaje nuevo del huésped:
"""
${userMessage}
"""

Extrae los datos actualizados.`;

  const resp = await callClaudeJson<{
    checkIn: string | null;
    checkOut: string | null;
    guests: number | null;
    property: string | null;
    city: string | null;
    intent: string;
  }>(
    {
      system,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 256,
      temperature: 0,
    },
    env,
  );

  if (!resp.ok || !resp.data) {
    return { ok: false, error: resp.error };
  }

  // Validación + sanitización del output del modelo
  const d = resp.data;
  const validProperties: PropertySlug[] = [
    "villa-b11-palma-real",
    "casa-brisa",
    "casa-marea",
    "centro-morazan",
    "casa-lara-townhouse",
    "la-florida",
  ];
  const validCities: City[] = ["La Ceiba", "Tela", "Tegucigalpa"];
  const validIntents = [
    "providing_data",
    "asking_question",
    "confirming",
    "rejecting",
    "unknown",
  ] as const;

  const property =
    d.property && validProperties.includes(d.property as PropertySlug)
      ? (d.property as PropertySlug)
      : null;
  const city =
    d.city && validCities.includes(d.city as City) ? (d.city as City) : null;
  const intent = (
    validIntents.includes(d.intent as (typeof validIntents)[number])
      ? d.intent
      : "unknown"
  ) as ExtractionResult["intent"];

  // checkIn/checkOut: validar formato YYYY-MM-DD
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const checkIn = d.checkIn && isoDate.test(d.checkIn) ? d.checkIn : null;
  const checkOut = d.checkOut && isoDate.test(d.checkOut) ? d.checkOut : null;
  const guests =
    typeof d.guests === "number" && d.guests > 0 && d.guests <= 20
      ? d.guests
      : null;

  return {
    ok: true,
    data: { checkIn, checkOut, guests, property, city },
    intent,
  };
}
