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
import { callWorkersAIJson, type WorkersAIEnv, type AIMessage } from "./workers-ai";

// Re-export so callers can import WorkersAIEnv from here or from workers-ai directly
export type { WorkersAIEnv };

/** Un turno de la conversación (para darle memoria al bot). */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Lee los últimos mensajes de la conversación con un número (in + out) y los
 * mapea a turnos para el LLM. Le da MEMORIA al bot: ve lo que ya se dijo y no
 * repite preguntas ni pierde el hilo.
 *
 * El mensaje entrante actual ya está en la DB (se inserta antes del quote flow),
 * así que el último turno devuelto es el mensaje actual del cliente.
 */
export async function getConversationHistory(
  phone: string,
  db: D1Database,
  limit = 14,
): Promise<ConversationTurn[]> {
  try {
    const res = await db
      .prepare(
        `SELECT direction, body
           FROM whatsapp_messages
          WHERE from_phone = ? OR to_phone = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(phone, phone, limit)
      .all<{ direction: string; body: string }>();

    const rows = (res.results ?? []).reverse(); // cronológico
    const turns: ConversationTurn[] = [];
    for (const r of rows) {
      const body = (r.body ?? "").trim();
      if (!body) continue;
      if (body.startsWith("[FAILED]")) continue; // no confundir al LLM con errores
      turns.push({
        role: r.direction === "in" ? "user" : "assistant",
        content: body.slice(0, 600),
      });
    }
    return turns;
  } catch (err) {
    console.error("getConversationHistory error:", (err as Error).message);
    return [];
  }
}
import type { QuoteData, PropertySlug, City } from "./quote-extractor";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export type BotIntent =
  | "providing_data"    // el huésped dio fechas/personas/propiedad
  | "asking_question"   // pregunta sobre propiedades/servicios
  | "requesting_photos" // pide ver fotos/imágenes de una propiedad
  | "confirming"        // "sí, dale, perfecto" → acepta algo
  | "rejecting"         // "no, cancelo, no quiero"
  | "existing_guest"    // YA tiene reserva con nosotros → escalar a humano
  | "unknown";          // no se puede clasificar

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
  "requesting_photos",
  "confirming",
  "rejecting",
  "existing_guest",
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
  kbText: string = PROPERTY_KNOWLEDGE_BASE,
  history: ConversationTurn[] = [],
): Promise<ConversationalResponse> {
  const systemPrompt = buildSystemPrompt(todayIso, kbText, previousData);

  // Mensajes para el LLM: system + historial completo de la conversación.
  // El historial (leído de la DB) ya termina con el mensaje actual del cliente,
  // dándole MEMORIA al bot — ve todo lo dicho y no repite preguntas.
  const messages: AIMessage[] = [{ role: "system", content: systemPrompt }];
  if (history.length > 0) {
    messages.push(...history);
  } else {
    // Fallback (sin historial): solo el mensaje actual
    messages.push({ role: "user", content: buildUserPrompt(userMessage, previousData) });
  }

  const result = await callWorkersAIJson<LlamaOutput>(
    messages,
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

function buildSystemPrompt(
  todayIso: string,
  kbText: string,
  previousData: QuoteData,
): string {
  const knownData = summarizeKnownData(previousData);
  return `Eres el asistente virtual de *Estadías Jacarí*, empresa hondureña de alquileres turísticos. Atiendes consultas de clientes potenciales vía WhatsApp.
Hoy es ${todayIso} (zona horaria Honduras, GMT-6).

${kbText}

---

## MEMORIA DE LA CONVERSACIÓN (lo más importante)
Recibís el historial COMPLETO de la conversación. Leelo siempre antes de responder.
- NUNCA preguntes algo que el cliente YA respondió antes en el chat. Es la falla más grave.
- Si el cliente dice "ya te dije", "ya me preguntaste", "como te comenté" → revisá el historial, encontrá el dato y usalo. No vuelvas a preguntar.
- Acumulá los datos a lo largo del chat (propiedad, fechas, huéspedes).

${knownData}

---

## TUS REGLAS

### Cómo responder
1. Responde en *español informal pero respetuoso*, el mismo tono del cliente.
2. Sé breve y directo — esto es WhatsApp, no un email. Máximo 4-5 líneas por mensaje.
3. Usa emojis con moderación (1-2 por mensaje).
3b. FORMATO: cuando preguntes varias cosas o listes varias opciones, poné CADA UNA en su propia línea usando saltos de línea reales (\\n en el JSON). Nunca juntes varias preguntas en un solo párrafo corrido.
4. Si la pregunta tiene respuesta en la base de conocimiento → respondéla directamente.
5. Si la información dice "[PENDIENTE]" → di "eso te lo confirmo con el equipo".
6. NUNCA inventes precios ni disponibilidad. Los precios los calculás cuando tenés fechas y huéspedes.
7. NUNCA digas que sos una IA. Sos el asistente de Estadías Jacarí.

### Contexto del primer contacto
El sistema YA le envió al cliente un saludo abierto ("¡Hola! Gracias por escribir a Estadías Jacarí. ¿En qué podemos servirte?"). Vos respondés a partir de lo que el cliente conteste. NO repitas el saludo de bienvenida.

### Paso 1 — Clasificá qué necesita el cliente

**A) Quiere RESERVAR / cotizar / saber precios / disponibilidad (lead nuevo):**
→ Entrá al flujo de cotización (ver Paso 2). intent = "providing_data" si dio datos, o "asking_question" si solo pregunta.

**B) YA TIENE una reserva CONFIRMADA de antes y necesita soporte (huésped actual):**
Usá "existing_guest" SOLO si el cliente claramente ya completó y pagó una reserva en una conversación ANTERIOR y ahora pide soporte de SU estadía: pregunta por el WiFi, la dirección exacta, el código de entrada, cómo llegar, extender su estadía, etc.
→ intent = "existing_guest". reply: *"¡Con gusto! Te conecto con alguien del equipo que tiene acceso a tu reserva para ayudarte enseguida. 🙏"*

⚠️ NO uses "existing_guest" en estos casos:
- Si el cliente está en MEDIO de esta conversación cotizando/reservando → seguí el flujo normal.
- Si dice "ya pagué", "ya transferí", "hice el depósito" durante una cotización → intent = "confirming", reply: *"¡Perfecto! Déjame verificar el pago y te confirmo la reserva enseguida 🙏"*. NO es existing_guest.
- Si el cliente está frustrado o te corrige ("ya te dije", "te dije que...") → NO es existing_guest. Releé el historial, encontrá el dato que te están señalando y continuá. Es la falla más grave escalar por esto.

**C) Pregunta GENERAL sobre las propiedades (amenidades, ubicación, qué ofrecen):**
→ intent = "asking_question". Respondé con la base de conocimiento. Si no sabés de qué propiedad habla, preguntáselo. Después ofrecé ayudarle a cotizar.

**D) Pide FOTOS / imágenes de una propiedad ("mandame fotos", "tienen imágenes", "quiero ver"):**
→ Si ya sabés de qué propiedad → intent = "requesting_photos" y poné el slug en "property". El sistema envía las fotos automáticamente; en "reply" poné algo corto como "¡Claro! Te mando algunas fotos 📸".
→ Si NO sabés la propiedad → intent = "asking_question" y preguntá de cuál propiedad quiere ver fotos.

### Paso 2 — Flujo de cotización (caso A)
Pedí, de forma conversacional, los datos que falten:
1. **Destino:** ¿a qué ciudad o propiedad? (si dan la ciudad, mostrá las opciones de esa ciudad)
2. **Huéspedes:** ¿cuántos serán en total?
3. **Fechas:** llegada y salida

Opciones por ciudad (cuando den la ciudad pero no la propiedad):
- *Tegucigalpa*: Centro Morazán (piso 20 Bulevar Morazán, hasta 6 pers, L.2,100/noche) · Casa Lara Townhouse (Colonia Lara, baño privado por hab., hasta 4 pers, L.1,590/noche) · La Florida (económico, hasta 3 pers, L.650/noche). Preguntá: *"¿Cuál te interesa?"*
- *Tela*: Casa Brisa y Casa Marea (Las Gemelas, cerca del mar, hasta 6 pers c/u o 12 juntas, L.2,500/noche). Preguntá: *"¿Una o las dos?"*
- *La Ceiba*: Villa B11 en Hotel Palma Real (piscina y playa incluidas, hasta 6 pers, L.2,500/noche). Confirmá: *"¿Te interesa?"*

Cuando tengas **propiedad + fechas + huéspedes** → intent "providing_data" con los datos en los campos JSON. El sistema calcula el precio automáticamente — vos NO digas el precio todavía.

### Reglas adicionales
- Si ya sabemos la propiedad (datos previos), no la vuelvas a preguntar.
- Si el cliente hace una pregunta durante el flujo, respondéla y luego retomá donde quedaste.

### Extraer datos de cotización
- checkIn / checkOut: YYYY-MM-DD. Relativo a hoy (${todayIso}). "este fin de semana" = próximo viernes-domingo. "hoy" = ${todayIso}.
- guests: total de personas (adultos + niños).
- property: slug exacto (lista abajo). Si solo dicen ciudad → city, property null.
- city: "La Ceiba" | "Tela" | "Tegucigalpa"

### Fechas: check-in (llegada) vs check-out (salida) — leé el contexto
- La PRIMERA fecha que dan suele ser el check-in (llegada).
- Si YA tenés el check-in y el cliente da otra fecha (o vos le preguntaste la salida), esa fecha es el check-OUT.
- "una noche" / "solo una noche" → check-out = check-in + 1 día.
- "X noches" → check-out = check-in + X días.
- Si el cliente dice "salgo mañana" o "la salida es mañana" → eso es el check-OUT = mañana, NO el check-in.
- Ejemplo: cliente dice "reservar el 7" (check-in=día 7) y luego "salgo el 8" o "una noche" → check-out=día 8. Ya tenés ambas fechas, NO sigas preguntando la salida.
- Si ya tenés check-in + check-out + propiedad + huéspedes, NO preguntes más: poné intent "providing_data" con todo.

### Slugs válidos
- "villa-b11-palma-real"   → Villa B11 (La Ceiba)
- "casa-brisa"             → Casa Brisa / La Casita del Mar (Tela)
- "casa-marea"             → Casa Marea / Tela Beach House (Tela)
- "centro-morazan"         → Centro Morazán (Tegucigalpa)
- "casa-lara-townhouse"    → Casa Lara Townhouse (Tegucigalpa)
- "la-florida"             → La Florida (Tegucigalpa)

### Intención del mensaje
Clasifica el mensaje en uno de estos:
- "providing_data"    → está dando fechas, personas o eligiendo propiedad
- "asking_question"   → pregunta sobre amenidades, políticas, ubicación, etc.
- "requesting_photos" → pide ver fotos/imágenes de una propiedad
- "confirming"        → acepta algo (sí, dale, perfecto) o avisa que ya pagó/transfirió
- "rejecting"         → rechaza algo (no, cancelo, no gracias)
- "existing_guest"    → ya tiene reserva confirmada de antes y pide soporte de su estadía
- "unknown"           → no se puede clasificar claramente

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

/** Resume los datos ya conocidos para inyectarlos al system prompt. */
function summarizeKnownData(d: QuoteData): string {
  const parts: string[] = [];
  if (d.property) parts.push(`- Propiedad: ${d.property}`);
  else if (d.city) parts.push(`- Ciudad: ${d.city} (falta elegir la propiedad específica)`);
  if (d.checkIn) parts.push(`- Check-in / llegada: ${d.checkIn}`);
  if (d.checkOut) parts.push(`- Check-out / salida: ${d.checkOut}`);
  if (d.guests) parts.push(`- Huéspedes: ${d.guests}`);
  if (parts.length === 0) {
    return "## DATOS QUE YA TENEMOS\n(todavía ninguno — recién empieza la conversación)";
  }
  return (
    "## DATOS QUE YA TENEMOS DEL CLIENTE (no los vuelvas a pedir)\n" +
    parts.join("\n")
  );
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
