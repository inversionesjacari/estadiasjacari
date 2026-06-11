/// <reference types="@cloudflare/workers-types" />
//
// Orquestador del quote flow — conecta el bot conversacional, el state machine
// y los helpers de cotización/pago.
//
// Punto de entrada: `handleQuoteIncoming` — se llama desde el webhook DESPUÉS
// de validar la firma y hacer INSERT del mensaje, ANTES del matching de reglas.
//
// Retorna:
//   - { reply, escalateToOwner, ruleName, tokensUsed } → responder al huésped
//   - null → no aplica, dejar que el webhook haga matching normal
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import {
  runConversationalBot,
  getConversationHistory,
  type WorkersAIEnv,
} from "./conversational-bot";
import {
  getState,
  upsertState,
  clearState,
  emptyQuoteData,
  isQuoteDataComplete,
  type ConvState,
  type ConversationStateRow,
} from "./quote-state";
import { buildQuote, formatQuoteMessage, type PropertyPricing } from "./quote-builder";
import { buildPricingMap, buildKnowledgeBaseText } from "./kb-store";
import { checkRangeAvailable, checkGemelasAvailable, type AvailabilityEnv } from "./availability";
import type { PropertySlug, City } from "./quote-extractor";
import { createPayPalOrder, type PayPalEnv } from "./paypal-checkout";
import {
  buildTransferMessageHNL,
  buildTransferMessageUSD,
  isUsdRequest,
} from "./bank-transfer";
import { getPropertyPhotos, getGalleryUrl } from "./property-photos";
import { T, asLang } from "./i18n";
import type { QuoteData } from "./quote-extractor";

// ─────────────────────────────────────────────────────────────────────────────
// Detectors rápidos (sin LLM)
// ─────────────────────────────────────────────────────────────────────────────

/** Detecta si un texto tiene intención de pedir cotización / precio. */
export function isPriceIntent(text: string): boolean {
  const norm = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡]/g, "")
    .trim();
  const patterns = [
    "precio",
    "cuanto cuesta",
    "cuanto sale",
    "cuanto vale",
    "tarifa",
    "cotizacion",
    "cotizar",
    "cuanto es",
    "valor",
    "que tal sale",
    "que precios",
    "tienen disponibilidad",
    "hay disponibilidad",
    "esta disponible",
    "estan disponibles",
    "reservar",
    "quiero reservar",
    "me interesa rentar",
    "me interesa alquilar",
  ];
  return patterns.some((p) => norm.includes(p));
}

/** Detecta intent de confirmación afirmativa. */
export function isConfirmation(text: string): boolean {
  const norm = text.toLowerCase().trim();
  // Negación clara → NO es confirmación, aunque incluya "ya"/"ok"/"listo".
  // Ej: "ya no, gracias", "ok no", "no por ahora", "mejor no". Evita el peor caso:
  // pedirle pagar a alguien que está rechazando (bug real: "Ya no muchas gracias").
  if (/\b(no|nel|nop|tampoco|nada|ya no|olvidalo|olvídalo|dejalo|déjalo|cancela|cancelar|mejor no)\b/.test(norm)) {
    return false;
  }
  return /\b(si|sí|claro|por supuesto|ok|dale|confirmo|de acuerdo|perfecto|ya|listo)\b/.test(norm);
}

/** Detecta si el huésped eligió tarjeta/PayPal. */
export function isCardChoice(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(tarjeta|paypal|tdc|tdb|credito|cr[eé]dito|d[eé]bito|link)\b/.test(t);
}

/** Detecta si el huésped eligió transferencia bancaria. */
export function isTransferChoice(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(transferencia|transferir|banco|cuenta|dep[oó]sito|deposito|bac|ach)\b/.test(t);
}

/** Detecta si el huésped pide los DATOS de cuenta para transferir. */
export function isBankAccountRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(transferencia|transferir|dep[oó]sito|deposito)\b/.test(t) ||
    /(a qu[eé] cuenta|n[uú]mero de cuenta|datos de la? cuenta|datos bancarios|cuenta del banco|cuenta bac|d[oó]nde (transfiero|deposito|dep[oó]sito|pago))/.test(t)
  );
}

/** Detecta si el huésped pide ver fotos / conocer la propiedad (es/en). Incluye
 *  pedir las REDES SOCIALES / Instagram / la página "para ver el lugar": eso es un
 *  pedido de fotos, NO algo fuera de alcance (era la causa del escalado de Natalia). */
export function isPhotoRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (
    /\b(foto|fotos|fotografia|fotografias|imagen|imagenes)\b/.test(t) ||
    /(ver|conocer|mostrar|muestra|ensena).{0,15}(casa|propiedad|lugar|villa|apartamento|depto|cuarto|habitaci)/.test(t) ||
    // pide las redes / el perfil / la página "para ver el lugar" → es pedir fotos
    /\b(redes sociales|red social|instagram|insta|facebook|tiktok|su perfil|su pagina|pagina web|sitio web|catalogo)\b/.test(t) ||
    /\b(photo|photos|picture|pictures|images?|social media|instagram|facebook)\b/.test(t) ||
    /(see|show).{0,15}(house|place|property|villa|apartment|room)/.test(t)
  );
}

// Redes y web OFICIALES de Estadías Jacarí — los MISMOS del footer del sitio
// (src/components/Footer.tsx). Si el cliente pide una, le damos ESE link (César:
// "si te piden insta hay que darles insta; adicional pueden ir las fotos").
const SOCIAL = {
  instagram: "https://www.instagram.com/estadiasjacari",
  facebook:  "https://www.facebook.com/profile.php?id=100078132980551",
  web:       "https://estadiasjacari.com",
} as const;

/**
 * ¿El cliente pidió una RED social / la web puntual? Devuelve cuáles dar (o null).
 * "redes"/"perfil" genérico → las tres. Pedir esto NUNCA es out_of_scope.
 */
function socialRequested(text: string): { ig: boolean; fb: boolean; web: boolean } | null {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const ig      = /\b(instagram|insta)\b/.test(t);
  const fb      = /\b(facebook|fb|messenger)\b/.test(t);
  const web     = /(pagina web|sitio web|website|\bsu sitio\b|\bla web\b|\bsu web\b)/.test(t);
  const generic = /\b(redes|red social|sus paginas|su perfil|sus perfiles|catalogo)\b/.test(t);
  if (!ig && !fb && !web && !generic) return null;
  if (generic && !ig && !fb && !web) return { ig: true, fb: true, web: true };
  return { ig, fb, web };
}

/** Arma el mensaje con los links de redes/web que pidió el cliente. */
function buildSocialReply(sel: { ig: boolean; fb: boolean; web: boolean }, lang: "es" | "en"): string {
  const lines: string[] = [];
  if (sel.ig)  lines.push(`📸 Instagram: ${SOCIAL.instagram}`);
  if (sel.fb)  lines.push(`👍 Facebook: ${SOCIAL.facebook}`);
  if (sel.web) lines.push(`🌐 ${lang === "en" ? "Website" : "Página web"}: ${SOCIAL.web}`);
  const intro = lang === "en" ? "Of course! Here you can find us 👇" : "¡Claro! Acá podés encontrarnos 👇";
  return `${intro}\n${lines.join("\n")}`;
}

/**
 * Señales CLARAS de que el lead ya NO está interesado: rechazó por precio, se
 * despidió, o postergó. Se usa para NO molestarlo con el "último aviso" antes de
 * cerrar la ventana de 24h. Conservador: solo casos evidentes (mejor dejar pasar
 * un cierre sutil que insistirle a alguien que ya dijo que no).
 */
export function isNotInterested(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return (
    // rechazo por precio
    /\b(no me conviene|muy caro|esta caro|carisimo|fuera de (mi )?presupuesto|no me alcanza|se (me )?pasa de presupuesto|esta fuera de)\b/.test(t) ||
    // postergación / "otra vez será"
    /\b(lo pienso|lo voy a pensar|despues (te )?(veo|aviso|escribo|digo)|mas adelante|otra ocasion|por ahora no|no por ahora|sera (en )?otra|en otra ocasion|tal vez (luego|despues|mas adelante))\b/.test(t) ||
    // despedida cortés como mensaje completo (no "gracias, ¿cómo pago?")
    /^(muchas gracias|gracias|ok gracias|listo gracias|igualmente|esta bien gracias)[.! ]*$/.test(t)
  );
}

/** Detecta si el huésped reporta que ya hizo el pago (escalar para verificar). */
export function isPaymentReported(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return /\b(ya pague|ya page|ya transferi|hice el deposito|ya deposite|pago realizado|pago hecho|ya hice el pago|envie el comprobante|aqui esta el comprobante|adjunto comprobante)\b/.test(t);
}

/**
 * En el paso "esperando comprobante", el cliente dice que TODAVÍA no hizo la
 * transferencia o la posterga (no es un comprobante). Ej: "No", "todavía no",
 * "primero se valida con la familia", "después", "mañana".
 */
export function indicatesNotDoneYet(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return (
    /^(no|nop|todavia no|aun no|negativo)\b/.test(t) ||
    /\b(todavia no|aun no|primero|despues|mas tarde|luego|manana|en un rato|ahorita no|no (lo|la) (he|hice)|no he (hecho|transferido|pagado)|estamos validando|se valida|valido con|consulto con|consultar con|aun estamos|todavia estamos)\b/.test(t)
  );
}

/** Cliente pide explícitamente que lo llamen por teléfono → mejor lo toma un humano
 *  (César llama). No tiene sentido seguir el flujo automático si quiere hablar. */
export function isCallRequested(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return /\b(me puede llamar|me pueden llamar|puede llamarme|pueden llamarme|que me llame|que me llamen|llamenme|llamame|me puede marcar|me pueden marcar|marquenme|prefiero una llamada|mejor una llamada|quiero una llamada|me podrian llamar|podrian llamarme)\b/.test(t);
}

/**
 * Cliente pide un NÚMERO de teléfono / contacto para llamar él (distinto de pedir
 * que LO llamen, que es isCallRequested). Pedir un teléfono NO es "fuera de
 * alcance": se da el número, amablemente y directo.
 */
export function isPhoneNumberRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // "numero" solo cuenta con contexto telefónico/contacto/llamar — así NO roba
  // "numero de personas" ni "numero de cuenta" (eso es isBankAccountRequest).
  return (
    /\b(numero de telefono|numero telefonico|numero de contacto|telefono de contacto|numero para llamar)\b/.test(t) ||
    /\b(tienen|tenes|tienes|hay) (un |algun )?telefono\b/.test(t) ||
    /\b(me (pasas?|pasan?|das?|dan?|facilitas?)|me (podes|podrias) (pasar|dar)) (un |el |su |tu )?telefono\b/.test(t) ||
    /\b(a que (numero|telefono)) (llamo|los llamo|marco|marcar|puedo llamar|te llamo)\b/.test(t) ||
    /\b(ocupo|necesito|quiero|dame|deme|pasame|paseme) (un |el |su |tu )?telefono\b/.test(t) ||
    /\b(phone number|number to call|contact number|your (phone )?number)\b/.test(t)
  );
}

/**
 * Cliente con DUDA de legitimidad / miedo a estafa: "¿son reales?", "¿esto es
 * estafa?", "¿es confiable?", "¿cómo confirmo su veracidad?", "¿es seguro pagar?".
 * Es la objeción más cara JUSTO antes de transferir: el cliente tiene la plata
 * lista y solo le falta confianza. Ignorarla —o, peor, repetir "mandame el
 * comprobante"— lo hace huir y nos hace ver como la estafa que teme. Se atiende
 * determinístico en CUALQUIER estado, con pruebas reales (empresa registrada +
 * redes + Airbnb). NO roba "número de cuenta" (eso es isBankAccountRequest).
 */
export function isLegitimacyQuestion(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (
    // estafa / fraude / engaño / timo
    /\b(estafa|estafan|estafar|fraude|fraudulent|timo|enga[nñ]o|enga[nñ]an)\b/.test(t) ||
    // ¿son reales? / ¿esto es real? / ¿de verdad existen?
    /\b(son|es|sera|seran) reales?\b/.test(t) ||
    /\b(esto|esta|este|todo|ustedes) (es|son) (real|reales|cierto|verdad)\b/.test(t) ||
    /\b(de verdad|realmente) (existen|son reales?|trabajan|alquilan|rentan)\b/.test(t) ||
    // confiable / de fiar / serios / legítimos
    /\b(confiable|confiables|de fiar|son serios|es serio|legitim[oa]s?|reales)\b/.test(t) ||
    /\b(puedo|se puede|podemos) confiar\b/.test(t) ||
    // veracidad / verificar / "cómo sé que son reales / no es estafa"
    /\bveracidad\b/.test(t) ||
    /\bconfirmar (su|la) (veracidad|legitimidad|autenticidad|identidad)\b/.test(t) ||
    /\bcomo\b.*\b(se que|confirmo|verifico|compruebo|asegur)\b.*\b(real|reales|estafa|confiable|legitim|cierto|fiar|veracidad)\b/.test(t) ||
    // ¿es seguro pagar / transferir?
    /\bes seguro\b.*\b(pagar|transferir|deposit|comprar|reservar|enviar|mandar)\b/.test(t) ||
    // inglés
    /\b(is|are) (this|you|it|they)( a)? (real|legit|legitimate|trustworthy|scam|safe)\b/.test(t) ||
    /\b(scam|fraud|legit|trustworthy)\b/.test(t) ||
    /\bhow (do|can) i (know|be sure|trust|verify)\b/.test(t) ||
    /\bis it safe to (pay|transfer|send)\b/.test(t) ||
    /\bcan i trust\b/.test(t)
  );
}

/** Cliente pide la ubicación / cómo llegar / el mapa. */
export function isLocationRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return /\b(ubicacion|ubicados?|ubicada|donde (estan|esta|queda|quedan|se encuentra|ubicad)|como llegar|direccion|el mapa|un mapa|en maps|google maps|location|where (are|is)|address)\b/.test(t);
}

// Links de Google Maps por propiedad. Tocar el link abre Google Maps en iPhone Y
// Android (es un URL google.com → nunca cae en Apple Maps), que es lo que la mayoría
// usa en Honduras. WhatsApp muestra la miniatura del mapa con el pin en la preview.
// Las de Tela comparten el complejo Shores Plantation, así que comparten link.
const PROPERTY_MAPS: Partial<Record<PropertySlug, string>> = {
  "casa-brisa":           "https://maps.app.goo.gl/EQYzmV7sfnVr2ZFs9",
  "casa-marea":           "https://maps.app.goo.gl/EQYzmV7sfnVr2ZFs9",
  "las-gemelas-tela":     "https://maps.app.goo.gl/EQYzmV7sfnVr2ZFs9",
  "villa-b11-palma-real": "https://maps.app.goo.gl/1JN66ajXPAmL3xtA6",
  "centro-morazan":       "https://maps.app.goo.gl/KwBr1PAt79UyNogU6",
  // PENDIENTE (pedir a César los links): casa-lara-townhouse, la-florida.
};

// Links por CIUDAD: para cuando el cliente pide la ubicación explorando una ZONA sin
// haber fijado una propiedad. Tela (Brisa+Marea, mismo predio) y La Ceiba (Villa B11)
// tienen un link común. Tegucigalpa NO está acá a propósito: 3 casas en zonas
// distintas → el bot pregunta de cuál (regla 10 del prompt).
const CITY_MAPS: Partial<Record<City, string>> = {
  "Tela":     "https://maps.app.goo.gl/EQYzmV7sfnVr2ZFs9",
  "La Ceiba": "https://maps.app.goo.gl/1JN66ajXPAmL3xtA6",
};

/**
 * Detecta la propiedad o ZONA que el cliente nombró EXPLÍCITAMENTE en su mensaje y
 * devuelve su link de Google Maps. Esto manda sobre el contexto: si venían hablando
 * de Centro Morazán pero el cliente escribe "ubicación de Tela", hay que mandar Tela,
 * no lo de antes. Devuelve undefined si no nombra nada con link conocido (o si nombra
 * Tegucigalpa, ambigua: 3 casas distintas → que el bot pregunte de cuál).
 */
function locationFromText(text: string): string | undefined {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Propiedad nombrada explícitamente (gana sobre la ciudad).
  if (/\bcasa\s*brisa\b|\bcasita del mar\b/.test(t))        return PROPERTY_MAPS["casa-brisa"];
  if (/\bcasa\s*marea\b|\btela beach house\b/.test(t))      return PROPERTY_MAPS["casa-marea"];
  if (/\bvilla\s*b\s*-?\s*11\b|\bpalma real\b/.test(t))     return PROPERTY_MAPS["villa-b11-palma-real"];
  if (/\bcentro\s*morazan\b|\bmorazan\b/.test(t))           return PROPERTY_MAPS["centro-morazan"];
  // Zona/ciudad. Tela (Brisa+Marea) y La Ceiba (Villa B11) tienen link común;
  // Tegucigalpa NO está acá a propósito (3 casas distintas → undefined → el bot pregunta).
  if (/\btela\b/.test(t))                                   return CITY_MAPS["Tela"];
  if (/\b(la\s*)?ceiba\b/.test(t))                          return CITY_MAPS["La Ceiba"];
  return undefined;
}

/** Slug de la propiedad nombrada explícitamente en el texto (o undefined). */
function propertySlugFromText(text: string): PropertySlug | undefined {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/\bcasa\s*brisa\b|\bcasita del mar\b/.test(t))    return "casa-brisa";
  if (/\bcasa\s*marea\b|\btela beach house\b/.test(t))  return "casa-marea";
  if (/\bvilla\s*b\s*-?\s*11\b|\bpalma real\b/.test(t)) return "villa-b11-palma-real";
  if (/\bcentro\s*morazan\b|\bmorazan\b/.test(t))       return "centro-morazan";
  if (/\bcasa\s*lara\b/.test(t))                        return "casa-lara-townhouse";
  if (/\bla florida\b/.test(t))                         return "la-florida";
  return undefined;
}

/**
 * Resuelve qué propiedad usar para mandar FOTOS: la nombrada en el texto, la del
 * contexto, o la representativa de la ciudad (Tela→Casa Brisa, La Ceiba→Villa B11,
 * fotos casi idénticas entre gemelas). Tegucigalpa (3 casas distintas) o sin
 * contexto → undefined: que el LLM pregunte de cuál querés ver fotos.
 */
function propertyForPhotos(text: string, existing: ConversationStateRow | null): PropertySlug | undefined {
  return (
    propertySlugFromText(text) ??
    existing?.data.property ??
    (existing?.data.city === "Tela" ? "casa-brisa"
      : existing?.data.city === "La Ceiba" ? "villa-b11-palma-real"
      : undefined)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ─────────────────────────────────────────────────────────────────────────────

/** Resultado de procesar un mensaje en el quote flow. */
export interface QuoteFlowResult {
  /** Texto a responder por WhatsApp. */
  reply: string;
  /** Si true: escalar a César (mostrar en inbox como urgente). */
  escalateToOwner: boolean;
  /** Nombre de la "regla" para logging. */
  ruleName: string;
  /** Tokens LLM consumidos en este turn (0 si no se llamó). */
  tokensUsed: number;
  /** URLs de imágenes a enviar (fotos de la propiedad). El webhook las manda. */
  images?: string[];
  /** Si true: el webhook manda el texto con preview_url activado para que WhatsApp
   *  muestre la miniatura del link (ej. el mapa con el pin de Google Maps). */
  previewUrl?: boolean;
  /** Si true: el webhook NO responde nada (glitch técnico → dejar que el bot se
   *  recupere solo en el próximo mensaje, sin mensaje raro ni escalación). */
  silent?: boolean;
}

export interface QuoteFlowEnv extends WorkersAIEnv, PayPalEnv, AvailabilityEnv {
  DB: D1Database;
}

// ─────────────────────────────────────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Procesa un mensaje entrante en el contexto del quote flow.
 *
 * @param hasActiveReservation  true si el huésped tiene una reserva activa en D1.
 *   Cuando es true y NO hay un quote flow en progreso, retornamos null para que
 *   el rule-based bot maneje al huésped existente (check-in, etc.).
 *   Cuando es false (potencial nuevo huésped) respondemos a CUALQUIER mensaje.
 */
export async function handleQuoteIncoming(
  phone: string,
  text: string,
  todayIso: string,
  env: QuoteFlowEnv,
  hasActiveReservation = false,
): Promise<QuoteFlowResult | null> {
  const existing = await getState(phone, env.DB);

  // Mapa de precios/capacidad desde D1 (editable). Fallback al hardcoded.
  // Se construye una vez por mensaje y se pasa a todos los sub-handlers.
  const pricingMap = await buildPricingMap(env.DB);

  // Idioma del cliente persistido en el estado (para responder en su idioma).
  const lang = asLang(existing?.data.language);

  // ── Cliente pide la UBICACIÓN → mandar el link del mapa ────────────────────
  // "Siempre debe enviarse la ubicación" (César). Funciona en CUALQUIER estado:
  // si están en pleno pago y preguntan dónde queda, mandamos el mapa Y recordamos
  // el método de pago, sin que el bot se "cierre" ni pierda el hilo.
  if (isLocationRequest(text) && existing) {
    // Mapa por propiedad si ya hay una elegida; si el cliente explora una ZONA
    // con casas que comparten ubicación (Tela: Brisa+Marea; La Ceiba), usamos el
    // mapa de la ciudad. Así no hace falta que haya fijado UNA propiedad.
    const mapUrl =
      locationFromText(text) ?? // lo que el cliente nombró AHORA gana sobre el contexto
      (existing.data.property ? PROPERTY_MAPS[existing.data.property] : undefined) ??
      (existing.data.city ? CITY_MAPS[existing.data.city] : undefined);
    if (mapUrl) {
      const base = lang === "en"
        ? `Here's the location 📍\n${mapUrl}`
        : `Acá te comparto la ubicación 📍\n${mapUrl}`;
      const tail = existing.state === "awaiting_payment_method"
        ? (lang === "en"
            ? "\n\nWhenever you're ready, tell me *Card* or *Transfer* to confirm 🌴"
            : "\n\nCuando quieras, decime *Tarjeta* o *Transferencia* para confirmar 🌴")
        : "";
      return {
        reply:           base + tail,
        previewUrl:      true, // el webhook activa preview_url → miniatura del mapa con el pin
        escalateToOwner: false,
        ruleName:        "location_sent",
        tokensUsed:      0,
      };
    }
  }

  // ── Cliente pide un NÚMERO de teléfono / para llamar → darlo directo ────────
  // Pedir un teléfono NO es "fuera de alcance": se da el número amablemente, sin
  // disculpas ni recitar las ciudades (el out_of_scope_redirect NO aplica acá).
  // Determinístico, antes del LLM, para que no lo malinterprete como out_of_scope.
  if (isPhoneNumberRequest(text)) {
    return {
      reply:           T.phoneContact(lang),
      escalateToOwner: false,
      ruleName:        "phone_contact_sent",
      tokensUsed:      0,
    };
  }

  // ── Cliente pide una RED / la web (Instagram, Facebook, página) → darle el link ──
  // Lo que pidió: Instagram → Instagram; Facebook → Facebook; web → la página;
  // "redes" a secas → las tres. Si además sabemos la propiedad, sumamos fotos.
  // Determinístico, ANTES del LLM: pedir las redes NUNCA es out_of_scope (caso
  // Natalia). Funciona aunque no haya estado (los links son fijos).
  {
    const social = socialRequested(text);
    if (social) {
      const photoSlug = propertyForPhotos(text, existing);
      const photos = photoSlug ? getPropertyPhotos(photoSlug) : [];
      const inPayment = existing?.state === "awaiting_payment_method";
      const parts = [buildSocialReply(social, lang)];
      if (photoSlug && photos.length > 0) {
        parts.push(
          (lang === "en" ? "And here are some photos 📸" : "Y acá te van unas fotos 📸") +
            T.photosGallery(lang, getGalleryUrl(photoSlug)),
        );
      }
      return {
        reply:           parts.join("\n\n") + (inPayment ? T.resumePaymentTail(lang) : ""),
        images:          photos,
        escalateToOwner: false,
        ruleName:        "social_links_sent",
        tokensUsed:      0,
      };
    }
  }

  // ── Cliente quiere VER el lugar (fotos / "mostrame el lugar") ───────────────
  // Pedir fotos NO es out_of_scope: es un pedido caliente. Determinístico, ANTES
  // del LLM, para que no lo mande a "fuera de alcance" (eso escalaba + pausaba el
  // bot y dejaba morir el lead — caso Natalia). En pago, recordamos el método.
  if (isPhotoRequest(text) && existing) {
    const photoSlug = propertyForPhotos(text, existing);
    if (photoSlug) {
      const photos = getPropertyPhotos(photoSlug);
      if (photos.length > 0) {
        const inPayment = existing.state === "awaiting_payment_method";
        return {
          reply:           T.photosIntro(lang) + T.photosGallery(lang, getGalleryUrl(photoSlug)) + (inPayment ? T.resumePaymentTail(lang) : ""),
          images:          photos,
          escalateToOwner: false,
          ruleName:        inPayment ? "photos_during_payment" : "photos_sent",
          tokensUsed:      0,
        };
      }
    }
  }

  // ── Cliente con DUDA de legitimidad / miedo a estafa → tranquilizar con PRUEBAS ──
  // "¿son reales?", "¿cómo confirmo su veracidad?", "¿es seguro pagar?" es la objeción
  // más cara JUSTO antes de transferir: el cliente tiene la plata lista y solo le falta
  // confianza. El paso de pago/comprobante es 100% determinístico y se TRAGABA estas
  // preguntas (repetía "mandame el comprobante" — caso Emilio, que parecía una estafa).
  // Determinístico, ANTES del LLM y en CUALQUIER estado; tras tranquilizar, retomamos
  // exactamente donde iba (comprobante / método / PayPal / seguir cotizando).
  if (isLegitimacyQuestion(text)) {
    let tail: string;
    if (existing?.state === "awaiting_transfer_proof") {
      tail = lang === "en"
        ? "\n\nWhenever you've made the transfer, just send me a photo of the receipt here and I'll confirm your booking. 🙏"
        : "\n\nCuando hagas la transferencia, mandame la foto del comprobante por acá y te confirmo la reserva. 🙏";
    } else if (existing?.state === "awaiting_payment_method") {
      tail = T.resumePaymentTail(lang);
    } else if (existing?.state === "awaiting_paypal_capture") {
      tail = lang === "en"
        ? "\n\nYour PayPal link is still active — once the payment goes through, you're all set. 🙏"
        : "\n\nTu link de PayPal sigue activo — apenas se procese el pago, queda lista tu reserva. 🙏";
    } else {
      tail = lang === "en"
        ? "\n\nWant to go ahead with your booking?"
        : "\n\n¿Seguimos con tu reserva?";
    }
    return {
      reply:           T.trustReassurance(lang) + tail,
      escalateToOwner: false,
      ruleName:        "legitimacy_reassured",
      tokensUsed:      0,
    };
  }

  // ── CASO 1: Sin estado activo ──────────────────────────────────────────────
  if (!existing) {
    // Huésped existente sin quote flow en curso → dejar que el rule-bot responda
    if (hasActiveReservation) return null;
    // Potencial nuevo huésped → siempre iniciar el funnel (cualquier mensaje)
    return gatherQuoteData(phone, text, emptyQuoteData(), todayIso, env, true, null, pricingMap);
  }

  // ── CASO 2: Quote ya entregado, esperando "sí" ─────────────────────────────
  if (existing.state === "quote_provided") {
    if (isConfirmation(text)) {
      await upsertState(phone, "awaiting_payment_method", existing.data, env.DB);
      const quote = await buildQuote(
        {
          property: existing.data.property!,
          checkIn:  existing.data.checkIn!,
          checkOut: existing.data.checkOut!,
          guests:   existing.data.guests!,
        },
        env.DB,
        pricingMap,
      );
      const depositLine = quote
        ? `*HNL ${quote.depositHNL.toLocaleString("es-HN")}* (≈ USD ${quote.depositUSD.toFixed(2)})`
        : lang === "en" ? "the 50% deposit" : "el 50% de la cotización";
      return {
        reply:           T.askPaymentMethod(lang, depositLine),
        escalateToOwner: false,
        ruleName:        "quote_confirmed_ask_method",
        tokensUsed:      0,
      };
    }
    // No confirmó → volver a recolectar datos (puede haber cambiado fechas)
    return gatherQuoteData(phone, text, existing.data, todayIso, env, false, existing.state, pricingMap);
  }

  // ── CASO 2.5: Esperando método de pago ────────────────────────────────────
  if (existing.state === "awaiting_payment_method") {
    return handlePaymentMethodChoice(phone, text, existing.data, env, pricingMap);
  }

  // ── CASO 2.6: Esperando captura PayPal ────────────────────────────────────
  if (existing.state === "awaiting_paypal_capture") {
    if (isUsdRequest(text)) {
      await cancelQuoteFlow(phone, env.DB);
      return {
        reply:           T.paypalUsdRequested(lang),
        escalateToOwner: true,
        ruleName:        "paypal_usd_requested",
        tokensUsed:      0,
      };
    }
    return {
      reply:           T.paypalPendingReminder(lang),
      escalateToOwner: false,
      ruleName:        "paypal_pending_reminder",
      tokensUsed:      0,
    };
  }

  // ── CASO 2.7: Esperando comprobante de transferencia ──────────────────────
  if (existing.state === "awaiting_transfer_proof") {
    if (isUsdRequest(text)) {
      const quote = await buildQuote(
        {
          property: existing.data.property!,
          checkIn:  existing.data.checkIn!,
          checkOut: existing.data.checkOut!,
          guests:   existing.data.guests!,
        },
        env.DB,
        pricingMap,
      );
      return {
        reply:           buildTransferMessageUSD(quote?.depositUSD ?? 0, lang),
        escalateToOwner: false,
        ruleName:        "transfer_usd_requested",
        tokensUsed:      0,
      };
    }
    // El cliente dice que TODAVÍA no transfirió / lo posterga ("No", "primero se
    // valida con la familia") → recordatorio amable, SIN asumir comprobante;
    // mantenemos el estado (sigue esperando la foto del comprobante).
    if (indicatesNotDoneYet(text)) {
      return {
        reply: lang === "en"
          ? "No problem! 🙏 Whenever you make the transfer, just send me a photo of the receipt here and we'll confirm. No rush."
          : "¡Sin problema! 🙏 Cuando hagas la transferencia, mandame la foto del comprobante por acá y te confirmamos. Sin apuro.",
        escalateToOwner: false,
        ruleName:        "transfer_pending_reminder",
        tokensUsed:      0,
      };
    }
    // El comprobante REAL es una FOTO (la captura el webhook). Acá llega TEXTO:
    // pedimos la foto para confirmar, sin asumir que ya la mandó (era el bug de
    // tratar cualquier texto —incluido "No"— como "recibí tu comprobante").
    return {
      reply: lang === "en"
        ? "Great! 🙏 To confirm your booking, please send me a photo of the transfer receipt here."
        : "¡Perfecto! 🙏 Para confirmar tu reserva, mandame por acá una foto del comprobante de la transferencia.",
      escalateToOwner: false,
      ruleName:        "transfer_ask_proof",
      tokensUsed:      0,
    };
  }

  // ── CASO 3: awaiting_quote_data — seguir recolectando datos ───────────────
  return gatherQuoteData(phone, text, existing.data, todayIso, env, false, existing.state, pricingMap);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recolección de datos de cotización vía bot conversacional.
 * Maneja tanto la fase inicial (estado nuevo) como actualizaciones posteriores.
 *
 * @param isFirstMessage true si es el primer mensaje del flow (estado vacío).
 */
async function gatherQuoteData(
  phone: string,
  text: string,
  previousData: QuoteData,
  todayIso: string,
  env: QuoteFlowEnv,
  isFirstMessage: boolean,
  previousState: ConvState | null,
  pricingMap: Record<PropertySlug, PropertyPricing>,
): Promise<QuoteFlowResult> {
  // Si es primer mensaje, crear el estado vacío antes de llamar al bot
  if (isFirstMessage) {
    await upsertState(phone, "awaiting_quote_data", emptyQuoteData(), env.DB);
  }

  // ── El cliente pide la cuenta para transferir + ya hay cotización completa ──
  // → mandamos los datos EXACTOS del banco (bank-transfer.ts), SIN pasar por el
  // LLM. El bot estaba alucinando números de cuenta; esto lo blinda.
  if (isBankAccountRequest(text) && isQuoteDataComplete(previousData)) {
    const tq = await buildQuote(
      { property: previousData.property!, checkIn: previousData.checkIn!, checkOut: previousData.checkOut!, guests: previousData.guests! },
      env.DB,
      pricingMap,
    );
    if (tq && tq.available) {
      const lng = asLang(previousData.language);
      await upsertState(phone, "awaiting_transfer_proof", previousData, env.DB);
      return {
        reply: isUsdRequest(text) ? buildTransferMessageUSD(tq.depositUSD, lng) : buildTransferMessageHNL(tq.depositHNL, lng),
        escalateToOwner: false,
        ruleName: "transfer_details_sent",
        tokensUsed: 0,
      };
    }
  }

  // ── Base de conocimiento desde D1 (editable). Fallback al hardcoded. ───────
  const kbText = await buildKnowledgeBaseText(env.DB);

  // ── Historial de la conversación → memoria del bot (no repetir preguntas) ──
  const history = await getConversationHistory(phone, env.DB);

  // ── Llamada al bot conversacional (Workers AI / Llama) ────────────────────
  const botResult = await runConversationalBot(text, previousData, todayIso, env, kbText, history);

  if (!botResult.ok) {
    // Glitch técnico de Workers AI: NO respondemos nada (decisión de César).
    // Mejor el silencio que un mensaje raro o una falsa promesa de "un humano
    // te responde". El bot se recupera solo en el próximo mensaje del cliente.
    console.error("conversational-bot glitch (silencioso):", botResult.error);
    // 📸 CÁMARA: guardar el error EXACTO del LLM en D1 para diagnóstico.
    try {
      await env.DB.prepare(
        `INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'LLM_GLITCH', ?)`,
      ).bind(phone, String(botResult.error ?? "sin detalle").slice(0, 800)).run();
    } catch { /* best-effort */ }

    // MODO DEGRADADO: si el modelo respondió en texto plano (no JSON) — pasa
    // cuando Cloudflare rompe el modo JSON del modelo — usamos ese texto como
    // respuesta en vez de callar. El bot conversa (sin extracción estructurada),
    // mucho mejor que el silencio.
    if (botResult.degradedReply) {
      return {
        reply:           botResult.degradedReply,
        escalateToOwner: false,
        ruleName:        "bot_text_mode",
        tokensUsed:      botResult.tokensUsed,
      };
    }

    return {
      reply: "",
      silent: true,
      escalateToOwner: false,
      ruleName:        "bot_glitch_silent",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // Idioma detectado por el bot (o el guardado previamente). Default "es".
  const lang = asLang(botResult.extractedData.language ?? previousData.language);

  // ── Cliente reporta que ya pagó → escalar a humano para verificar el pago ──
  if (isPaymentReported(text)) {
    return {
      reply:           T.paymentReported(lang),
      escalateToOwner: true,
      ruleName:        "payment_reported",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Cliente pide que lo LLAMEN → escalar a un humano (César llama) ──────────
  // Lo que quiere es hablar con una persona; seguir el flujo automático lo frustra.
  if (isCallRequested(text)) {
    return {
      reply: lang === "en"
        ? "Of course! I'll let our team know so they can call you shortly 📞 What time works best for you?"
        : "¡Con gusto! Le aviso a nuestro equipo para que te llamen lo antes posible 📞 ¿En qué horario te queda mejor?",
      escalateToOwner: true,
      ruleName:        "call_requested",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Huésped existente → escalar a un humano del equipo ────────────────────
  // El que escribe ya tiene reserva (puede venir de otro número que no detectamos).
  // No intentamos resolver datos de su reserva por el bot: lo pasamos a un agente.
  if (botResult.intent === "existing_guest") {
    await cancelQuoteFlow(phone, env.DB);
    return {
      reply:           botResult.reply || T.existingGuest(lang),
      escalateToOwner: true,
      ruleName:        "existing_guest_escalation",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Fuera de alcance / no resoluble → redirigir al cliente + avisar al owner ─
  // El bot ya respondió con la redirección (incluye el WhatsApp del equipo).
  // escalateToOwner=true dispara el email + la etiqueta "escalado" en el inbox.
  // NO cancelamos el flow: si tenía una cotización en curso, puede retomarla.
  if (botResult.intent === "out_of_scope") {
    // Mensaje DETERMINÍSTICO en el idioma del cliente (no usamos el reply del
    // LLM, que a veces sale en el idioma equivocado — ej. español a un cliente
    // que escribe en inglés).
    const msg =
      lang === "en"
        ? "For now we only manage properties in La Ceiba, Tela and Tegucigalpa 🙏. For anything outside that, it's best to message our team directly at +504 9764-9035 → https://wa.me/50497649035. If you'd like, I'm happy to help you with one of our properties. 🌴"
        : "Por ahora solo manejamos propiedades en La Ceiba, Tela y Tegucigalpa 🙏. Para algo fuera de eso, lo mejor es escribirle directo a nuestro equipo al +504 9764-9035 → https://wa.me/50497649035. Si querés, con gusto te ayudo con alguna de nuestras propiedades. 🌴";
    return {
      reply:           msg,
      escalateToOwner: true,
      ruleName:        "out_of_scope_redirect",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Merge: los datos nuevos ganan sobre los previos cuando no son null ─────
  const mergedData: QuoteData = {
    checkIn:      botResult.extractedData.checkIn      ?? previousData.checkIn,
    checkOut:     botResult.extractedData.checkOut     ?? previousData.checkOut,
    guests:       botResult.extractedData.guests       ?? previousData.guests,
    property:     botResult.extractedData.property     ?? previousData.property,
    city:         botResult.extractedData.city         ?? previousData.city,
    paypalOrderId: previousData.paypalOrderId,
    depositUsd:    previousData.depositUsd,
    language:      lang,
  };

  // ── Ciudad sin casa elegida → auto-asignar la propiedad (decisión de César) ──
  // No hacemos elegir cuando no hace falta. La Ceiba tiene una sola casa. En Tela
  // las dos son casi idénticas: probamos Casa MAREA y, si está ocupada, Casa BRISA
  // (7-12 personas → las dos juntas); si AMBAS están ocupadas → no disponible.
  // Tegucigalpa NO se auto-asigna: las 3 casas son distintas, ahí el cliente elige.
  // Si el cliente pidió una casa puntual, `property` ya viene seteada y la respetamos.
  if (
    !mergedData.property &&
    mergedData.checkIn &&
    mergedData.checkOut &&
    typeof mergedData.guests === "number" &&
    mergedData.guests > 0
  ) {
    if (mergedData.city === "La Ceiba") {
      mergedData.property = "villa-b11-palma-real";
    } else if (mergedData.city === "Tela") {
      if (mergedData.guests <= 6) {
        // Casa Marea primero; si no se puede verificar (iCal caído) la asignamos
        // igual y el flujo de cotización la re-verifica + nota de confirmación.
        const marea = await checkRangeAvailable("casa-marea", mergedData.checkIn, mergedData.checkOut, env);
        if (marea.available || !marea.verified) {
          mergedData.property = "casa-marea";
        } else {
          const brisa = await checkRangeAvailable("casa-brisa", mergedData.checkIn, mergedData.checkOut, env);
          if (brisa.available || !brisa.verified) {
            mergedData.property = "casa-brisa";
          } else {
            // Ambas confirmadas ocupadas → no disponible en Tela para esas fechas.
            await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
            return {
              reply: lang === "en"
                ? "Unfortunately both our houses in Tela are booked for those dates 😔 Would you like me to check other dates or another area?"
                : "Lamentablemente las dos casas de Tela están ocupadas en esas fechas 😔 ¿Querés que revise otras fechas u otra zona?",
              escalateToOwner: false,
              ruleName:        "quote_unavailable_tela",
              tokensUsed:      botResult.tokensUsed,
            };
          }
        }
      } else if (mergedData.guests <= 12) {
        mergedData.property = "las-gemelas-tela"; // 7-12 → las dos casas juntas
      }
      // > 12: no asignamos (el prompt aclara que el máximo en Tela es 12).
    }
  }

  // ── Primer mensaje sin ningún dato (saludo genérico) → bienvenida fija ─────
  // Usamos el mensaje determinístico (formato perfecto garantizado) en vez de
  // depender de cómo el LLM formatee el saludo inicial.
  const noDataYet =
    !mergedData.checkIn &&
    !mergedData.checkOut &&
    !mergedData.guests &&
    !mergedData.property &&
    !mergedData.city;

  if (
    isFirstMessage &&
    noDataYet &&
    botResult.intent !== "asking_question" &&
    botResult.intent !== "requesting_photos"
  ) {
    // Persistir el idioma detectado para los siguientes mensajes.
    await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
    return {
      reply:           T.welcome(lang),
      escalateToOwner: false,
      ruleName:        "quote_welcome",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Pide fotos + sabemos la propiedad → enviar fotos + link a galería ─────
  if (botResult.intent === "requesting_photos" && mergedData.property) {
    const photos = getPropertyPhotos(mergedData.property);
    if (photos.length > 0) {
      // Mantener el state con lo que sepamos para seguir el flujo después
      await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
      const galleryUrl = getGalleryUrl(mergedData.property);
      const intro =
        botResult.reply && botResult.reply.trim().length > 0
          ? botResult.reply.trim()
          : T.photosIntro(lang);
      return {
        reply: `${intro}${T.photosGallery(lang, galleryUrl)}`,
        images: photos,
        escalateToOwner: false,
        ruleName: "photos_sent",
        tokensUsed: botResult.tokensUsed,
      };
    }
  }

  // ── ¿Cotizar? Solo si el mensaje ACTUAL aportó un dato nuevo/distinto ─────
  // Evita el bucle: si los datos ya estaban completos de antes y el cliente
  // manda un saludo ("que onda") o pide alternativas ("¿qué otra tienen?"),
  // NO recotizamos lo mismo — dejamos que el bot conversacional responda.
  const ex = botResult.extractedData;
  const changedQuoteData =
    (ex.property != null && ex.property !== previousData.property) ||
    (ex.checkIn  != null && ex.checkIn  !== previousData.checkIn) ||
    (ex.checkOut != null && ex.checkOut !== previousData.checkOut) ||
    (ex.guests   != null && ex.guests   !== previousData.guests);

  // ── ¿Tenemos todo para cotizar? ───────────────────────────────────────────
  if (isQuoteDataComplete(mergedData) && changedQuoteData) {
    const quote = await buildQuote(
      {
        property: mergedData.property!,
        checkIn:  mergedData.checkIn!,
        checkOut: mergedData.checkOut!,
        guests:   mergedData.guests!,
      },
      env.DB,
      pricingMap,
    );

    if (!quote) {
      return {
        reply: T.quoteBuildError(lang),
        escalateToOwner: true,
        ruleName:        "quote_build_failed",
        tokensUsed:      botResult.tokensUsed,
      };
    }

    // ── Verificación de disponibilidad real (Airbnb iCal + D1) ──────────────
    // CRÍTICO: buildQuote solo mira D1. Acá verificamos también Airbnb para
    // NO cotizar fechas ya reservadas en otra plataforma (doble reserva).
    let availabilityNote = "";
    let escalateUnverified = false;
    if (quote.available) {
      // Las Gemelas juntas: verificar que AMBAS casas estén libres (anti doble reserva).
      const avail = mergedData.property === "las-gemelas-tela"
        ? await checkGemelasAvailable(mergedData.checkIn!, mergedData.checkOut!, env)
        : await checkRangeAvailable(mergedData.property!, mergedData.checkIn!, mergedData.checkOut!, env);
      if (avail.verified && !avail.available) {
        // Confirmado: las fechas están ocupadas en Airbnb → NO disponible
        await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
        return {
          reply: T.unavailable(lang, quote.propertyName),
          escalateToOwner: false,
          ruleName: "quote_unavailable_airbnb",
          tokensUsed: botResult.tokensUsed,
        };
      }
      if (!avail.verified) {
        // No pudimos consultar Airbnb → cotizar pero confirmar manualmente
        availabilityNote = T.availabilityNote(lang);
        escalateUnverified = true;
      }
    }

    const quoteMsg = formatQuoteMessage(
      quote,
      {
        property: mergedData.property!,
        checkIn:  mergedData.checkIn!,
        checkOut: mergedData.checkOut!,
        guests:   mergedData.guests!,
      },
      lang,
    );

    // Si el bot también respondió una pregunta, combinar ambas respuestas
    // (ej: "¿Hay piscina? Somos 4 del 15 al 20 en Villa B11")
    const baseReply =
      botResult.intent === "asking_question" && quote.available && !quote.exceedsCapacity
        ? `${botResult.reply}\n\n${quoteMsg}`
        : quoteMsg;
    const reply = baseReply + availabilityNote;

    const nextState: ConvState = quote.available ? "quote_provided" : "awaiting_quote_data";
    await upsertState(phone, nextState, mergedData, env.DB);

    return {
      reply,
      escalateToOwner: escalateUnverified,
      ruleName:        quote.available ? "quote_provided" : "quote_unavailable",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Datos incompletos / pregunta suelta — respuesta natural del bot ───────
  // MANTENEMOS "quote_provided" SOLO si ya se había entregado una cotización
  // DISPONIBLE (el estado previo ya era quote_provided) y el cliente solo hizo
  // una pregunta — así el seguimiento sabe que hay cotización y no re-pregunta.
  // PERO no PROMOVEMOS desde awaiting_quote_data: si la última cotización fue NO
  // disponible (quote_unavailable_airbnb deja awaiting_quote_data con los datos
  // completos), un "ok"/"sí" de cortesía posterior NO debe ascender a
  // quote_provided → confirmar → pedir pago de algo que no está disponible.
  // (Bug real: cliente Vania, 10-jun — declinó y el bot le pidió el depósito.)
  const keepState: ConvState =
    previousState === "quote_provided" && isQuoteDataComplete(mergedData)
      ? "quote_provided"
      : "awaiting_quote_data";
  await upsertState(phone, keepState, mergedData, env.DB);
  return {
    reply:           botResult.reply,
    escalateToOwner: false,
    ruleName:        "bot_gathering_data",
    tokensUsed:      botResult.tokensUsed,
  };
}

/**
 * Maneja la elección de método de pago (tarjeta vs transferencia).
 */
async function handlePaymentMethodChoice(
  phone: string,
  text: string,
  data: QuoteData,
  env: QuoteFlowEnv,
  pricingMap: Record<PropertySlug, PropertyPricing>,
): Promise<QuoteFlowResult> {
  const lang = asLang(data.language);
  const cardChoice     = isCardChoice(text);
  const transferChoice = isTransferChoice(text);

  if (!cardChoice && !transferChoice) {
    // El cliente no eligió método. Antes de repetir la aclaración (el bot la
    // machacaba ignorando al cliente), atendemos un pedido legítimo y muy común
    // ANTES de pagar: ver fotos / conocer la casa. Mandamos fotos + galería y le
    // recordamos el paso de pago, SIN salir del estado (no rompe el cobro).
    if (isPhotoRequest(text) && data.property) {
      const photos = getPropertyPhotos(data.property);
      if (photos.length > 0) {
        return {
          reply:           T.photosIntro(lang) + T.photosGallery(lang, getGalleryUrl(data.property)) + T.resumePaymentTail(lang),
          images:          photos,
          escalateToOwner: false,
          ruleName:        "photos_during_payment",
          tokensUsed:      0,
        };
      }
    }
    return {
      reply:           T.paymentMethodClarify(lang),
      escalateToOwner: false,
      ruleName:        "ask_payment_method_clarify",
      tokensUsed:      0,
    };
  }

  const quote = await buildQuote(
    {
      property: data.property!,
      checkIn:  data.checkIn!,
      checkOut: data.checkOut!,
      guests:   data.guests!,
    },
    env.DB,
    pricingMap,
  );

  if (!quote || !quote.available) {
    await cancelQuoteFlow(phone, env.DB);
    return {
      reply:           T.reservationError(lang),
      escalateToOwner: true,
      ruleName:        "payment_method_quote_fail",
      tokensUsed:      0,
    };
  }

  // ── Sub-flow A: Tarjeta / PayPal ──────────────────────────────────────────
  if (cardChoice) {
    const orderResult = await createPayPalOrder(
      {
        amountUsd:    quote.depositUSD,
        propertySlug: data.property!,
        propertyName: quote.propertyName,
        checkIn:      data.checkIn!,
        checkOut:     data.checkOut!,
        guests:       data.guests!,
        guestPhone:   phone,
      },
      env,
    );

    if (!orderResult.ok || !orderResult.approvalUrl) {
      console.error("PayPal create order failed:", orderResult.error);
      // Fallback automático a transferencia
      await upsertState(phone, "awaiting_transfer_proof", { ...data, depositUsd: quote.depositUSD }, env.DB);
      return {
        reply: T.paypalFallbackToTransfer(lang) + buildTransferMessageHNL(quote.depositHNL, lang),
        escalateToOwner: true,
        ruleName:        "paypal_fallback_to_transfer",
        tokensUsed:      0,
      };
    }

    await upsertState(
      phone,
      "awaiting_paypal_capture",
      { ...data, paypalOrderId: orderResult.orderId, depositUsd: quote.depositUSD },
      env.DB,
    );

    return {
      reply: T.paypalLink(
        lang,
        quote.depositHNL.toLocaleString("es-HN"),
        quote.depositUSD.toFixed(2),
        orderResult.approvalUrl,
        quote.balanceHNL.toLocaleString("es-HN"),
      ),
      escalateToOwner: false,
      ruleName:        "paypal_link_sent",
      tokensUsed:      0,
    };
  }

  // ── Sub-flow B: Transferencia bancaria ────────────────────────────────────
  await upsertState(phone, "awaiting_transfer_proof", { ...data, depositUsd: quote.depositUSD }, env.DB);
  return {
    reply:           buildTransferMessageHNL(quote.depositHNL, lang),
    escalateToOwner: true,
    ruleName:        "transfer_details_sent",
    tokensUsed:      0,
  };
}

/** Cancela el quote flow para un número (cuando el huésped pide hablar con humano). */
export async function cancelQuoteFlow(phone: string, db: D1Database): Promise<void> {
  await clearState(phone, db);
}
