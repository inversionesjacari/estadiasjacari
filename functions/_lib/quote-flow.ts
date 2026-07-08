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
  missingFields,
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
import { getPropertyPhotos, getBedroomPhotos, getGalleryUrl } from "./property-photos";
import { buildPropertyCard } from "./property-catalog";
import { T, asLang } from "./i18n";
import type { QuoteData } from "./quote-extractor";
import {
  indicatesNotDoneYet,
  isBankAccountRequest,
  isBareAck,
  isBedroomPhotoRequest,
  isCallRequested,
  isCardChoice,
  isCheckinTimeRequest,
  isConfirmation,
  isDateChangeOrAvailabilityQuestion,
  isFarewell,
  isLegitimacyQuestion,
  isLocationRequest,
  isLongTermRequest,
  isNotInterested,
  isPaymentReported,
  isPhoneNumberRequest,
  isPhotoRequest,
  isPostponing,
  isPriceIntent,
  isTransferChoice,
  cityFromText,
  LONG_TERM_NIGHTS,
  nightsBetween,
} from "./detectors";
// Re-export de los detectores puros (ahora viven en ./detectors) para no
// romper imports externos como cron/quote-followups.ts.
export {
  indicatesNotDoneYet,
  isBankAccountRequest,
  isBareAck,
  isBedroomPhotoRequest,
  isCallRequested,
  isCardChoice,
  isCheckinTimeRequest,
  isConfirmation,
  isDateChangeOrAvailabilityQuestion,
  isFarewell,
  isLegitimacyQuestion,
  isLocationRequest,
  isLongTermRequest,
  isNotInterested,
  isPaymentReported,
  isPhoneNumberRequest,
  isPhotoRequest,
  isPostponing,
  isPriceIntent,
  isTransferChoice,
  LONG_TERM_NIGHTS,
  nightsBetween,
} from "./detectors";
import { resolveDates } from "./date-parser";

// ─────────────────────────────────────────────────────────────────────────────
// Detectores puros → ahora viven en ./detectors (importados/re-exportados arriba).
// Acá quedan solo los helpers que tocan estado/D1 o constantes locales.
// ─────────────────────────────────────────────────────────────────────────────









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









/** Última regla saliente del bot para este número (o "" si no hay). Para saber si
 *  ya nos despedimos y no encimar otra despedida ante un "ok"/"gracias" de cierre. */
async function getLastOutRule(phone: string, db: D1Database): Promise<string> {
  try {
    const r = await db.prepare(
      `SELECT matched_rule FROM whatsapp_messages WHERE to_phone = ? AND direction = 'out' AND matched_rule IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(phone).first<{ matched_rule: string | null }>();
    return r?.matched_rule ?? "";
  } catch {
    return "";
  }
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
  "casa-lara-townhouse":  "https://maps.app.goo.gl/5ab9xZ5L53UxH9q88",
  "la-florida":           "https://maps.app.goo.gl/C9XARi5wky4MJ8dMA",
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
export function locationFromText(text: string): string | undefined {
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
  /** Si está seteado, el webhook intenta mandar una TARJETA NATIVA de producto
   *  (catálogo de WhatsApp: catalog_id + retailerId). Si falla (catálogo no listo,
   *  producto inexistente, env sin catalog_id), cae al `reply` + `images` (fallback). */
  productCard?: { retailerId: string; body?: string };
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
          buildPropertyCard(photoSlug, lang) ||
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
      const inPayment = existing.state === "awaiting_payment_method";
      // Pidió específicamente las HABITACIONES y tenemos fotos de dormitorios → mandamos
      // ESAS (no la tarjeta de marketing que abre con la sala). Caso real 14-jun: pidió
      // "fotos de las habitaciones" y le caía la sala. Si no hay fotos de dormitorios
      // para esa propiedad (ej. Villa B11), cae a las fotos normales de abajo.
      const bedroomPhotos = isBedroomPhotoRequest(text) ? getBedroomPhotos(photoSlug) : [];
      if (bedroomPhotos.length > 0) {
        const intro = lang === "en" ? "🛏️ Here are the bedrooms 📸" : "🛏️ Acá te van las habitaciones 📸";
        return {
          reply:           intro + T.photosGallery(lang, getGalleryUrl(photoSlug)) + (inPayment ? T.resumePaymentTail(lang) : ""),
          images:          bedroomPhotos,
          escalateToOwner: false,
          ruleName:        inPayment ? "bedroom_photos_during_payment" : "bedroom_photos_sent",
          tokensUsed:      0,
        };
      }
      const photos = getPropertyPhotos(photoSlug);
      if (photos.length > 0) {
        const card =
          buildPropertyCard(photoSlug, lang) ||
          T.photosIntro(lang) + T.photosGallery(lang, getGalleryUrl(photoSlug));
        return {
          reply:           card + (inPayment ? T.resumePaymentTail(lang) : ""),
          images:          photos,
          productCard:     { retailerId: photoSlug, body: T.photosIntro(lang) + (inPayment ? T.resumePaymentTail(lang) : "") },
          escalateToOwner: false,
          ruleName:        inPayment ? "photos_during_payment" : "photos_sent",
          tokensUsed:      0,
        };
      }
    }
  }

  // ── Cliente quiere una estadía a LARGO PLAZO (largo plazo / mensual) → caso especial ──
  // Para rentas largas armamos una propuesta a medida (no la tarifa por noche × N): lo
  // evalúa César. Si lo pide explícito ("largo plazo", "varios meses"), escalamos ya;
  // si lo dice por FECHAS (estadía de un mes+), se detecta en gatherQuoteData. Funciona
  // en cualquier estado. (Caso Vanina: 11 jul → 30 nov.)
  if (isLongTermRequest(text)) {
    return {
      reply:           T.longTermInquiry(lang),
      escalateToOwner: true,
      ruleName:        "long_term_inquiry",
      tokensUsed:      0,
    };
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

  // ── Cliente pregunta por el HORARIO de check-in/out DURANTE el pago → responder ──
  // El horario es un dato FIJO (3 PM / 11 AM, todas las propiedades) que el bot SÍ
  // contesta mientras junta datos (camino del LLM), pero los pasos de pago son 100%
  // determinísticos y se TRAGABAN la pregunta: la cliente preguntó 3 veces "a qué hora
  // puedo entrar" eligiendo método y esperando el comprobante, y el bot repitió el
  // guion de pago ignorándola (caso Sandra, 12-jun). Igual que ubicación/legitimidad:
  // respondemos el horario y RETOMAMOS el paso exacto. Solo en los pasos de pago — en
  // los demás estados el LLM ya lo contesta (y extrae datos si el mensaje los trae).
  {
    const inPaymentStep =
      existing?.state === "awaiting_payment_method" ||
      existing?.state === "awaiting_transfer_proof" ||
      existing?.state === "awaiting_paypal_capture";
    // Si en el MISMO mensaje el cliente además elige método ("transferencia, ¿a qué
    // hora entro?"), NO le robamos la elección: dejamos que el handler de pago la
    // procese (la pregunta de horario se contesta sola en el próximo paso). Solo aplica
    // en awaiting_payment_method, que es donde la elección de método tiene sentido.
    const carriesPaymentChoice =
      existing?.state === "awaiting_payment_method" && (isCardChoice(text) || isTransferChoice(text));
    if (inPaymentStep && isCheckinTimeRequest(text) && !carriesPaymentChoice) {
      let tail: string;
      if (existing!.state === "awaiting_transfer_proof") {
        tail = lang === "en"
          ? "\n\nWhenever you've made the transfer, send me a photo of the receipt here and I'll confirm your booking. 🙏"
          : "\n\nCuando hagas la transferencia, mandame la foto del comprobante por acá y te confirmo la reserva. 🙏";
      } else if (existing!.state === "awaiting_payment_method") {
        tail = T.resumePaymentTail(lang);
      } else {
        tail = lang === "en"
          ? "\n\nYour PayPal link is still active — once the payment goes through, you're all set. 🙏"
          : "\n\nTu link de PayPal sigue activo — apenas se procese el pago, queda lista tu reserva. 🙏";
      }
      return {
        reply:           T.checkinSchedule(lang) + tail,
        escalateToOwner: false,
        ruleName:        "checkin_schedule_sent",
        tokensUsed:      0,
      };
    }
  }

  // ── Despedida / acuse de cierre → cerrar cálido UNA vez, sin repetir ───────
  // El bot repetía la MISMA despedida ante cada "ok"/"gracias" de cierre (caso
  // Franci: "Ya no gracias" → despedida; "OK" → la MISMA despedida otra vez). Solo
  // en estados BLANDOS (sin pago en curso, para no cancelar un cobro por un "gracias"):
  //   · si el cliente se despide y aún no nos despedimos → UNA despedida determinística.
  //   · si YA nos despedimos (última regla = farewell) y manda otro cierre/"ok" → callar.
  //   · un "ok" suelto que NO viene tras una despedida cae al flujo normal ("ok" = sí).
  {
    const softState =
      !existing ||
      existing.state === "awaiting_quote_data" ||
      existing.state === "quote_provided";
    if (softState && (isFarewell(text) || isBareAck(text))) {
      // "Cerrado" = ya nos despedimos O ya mandamos el recordatorio de postergación
      // (el cliente dijo que confirma luego) → un "ok"/"sí"/"gracias" posterior NO se
      // re-responde (era el doble "¡Perfecto!…" del caso Yosmary).
      const lastRule = await getLastOutRule(phone, env.DB);
      const alreadyClosed = lastRule === "farewell" || lastRule === "postpone_reminder";
      if (alreadyClosed) {
        return { reply: "", silent: true, escalateToOwner: false, ruleName: "closing_ack_silent", tokensUsed: 0 };
      }
      if (isFarewell(text)) {
        return { reply: T.farewell(lang), escalateToOwner: false, ruleName: "farewell", tokensUsed: 0 };
      }
      // isBareAck sin despedida previa → sigue al flujo normal (puede ser "ok = sí").
    }
  }

  // ── Cliente posterga la confirmación ("le confirmo la otra semana") ─────────
  // Decisión de César: NO repetir el genérico "cuando estés listo, escribime" (no
  // motiva). Le informamos con calidez que las fechas se apartan SOLO con el depósito
  // y que no las garantizamos (orden de llegada) → lo motiva a no dejarlo pasar y a
  // escribirnos ANTES de depositar para confirmar disponibilidad (evita el depósito a
  // ciegas + el reembolso si ya estaba tomada). Solo cuando YA hay intención de
  // reserva: cotización entregada, datos completos, o eligiendo método de pago.
  if (existing && isPostponing(text)) {
    const bookingIntent =
      existing.state === "quote_provided" ||
      existing.state === "awaiting_payment_method" ||
      (existing.state === "awaiting_quote_data" && isQuoteDataComplete(existing.data));
    if (bookingIntent) {
      return {
        reply:           T.postponeReminder(lang),
        escalateToOwner: false,
        ruleName:        "postpone_reminder",
        tokensUsed:      0,
      };
    }
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
    // El cliente debe poder CAMBIAR DE FECHA aun en pleno pago — no machacarle "elegí
    // una opción". Si no eligió método y pregunta por otra fecha/disponibilidad,
    // volvemos al flujo de cotización para re-cotizar y adaptarnos.
    if (!isCardChoice(text) && !isTransferChoice(text) && isDateChangeOrAvailabilityQuestion(text)) {
      return gatherQuoteData(phone, text, existing.data, todayIso, env, false, existing.state, pricingMap);
    }
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

  // ── Fuera de alcance → declinar con amabilidad y REENFOCAR (sin escalar/pausar) ─
  // El cliente pidió algo que NO ofrecemos: otra zona (Roatán, Copán, México…), un
  // servicio que no damos, o una configuración que no tenemos (ej. "3 villas separadas
  // juntas"). Decisión de César (2026-06-11): NO escalar ni pausar el bot — solo decir
  // con naturalidad que no lo tenemos y reenfocar en nuestras zonas, que el bot siga
  // atendiendo. Nada de "escribile al equipo" (eso pausaba el bot y mataba el lead).
  // Mensaje DETERMINÍSTICO en el idioma del cliente (el reply del LLM a veces sale en
  // el idioma equivocado). Sin 🌴: out_of_scope no tiene zona de playa fija.
  let overrodeOutOfScope = false;
  if (botResult.intent === "out_of_scope") {
    // Red determinística (caso Alisson, 7-jul-2026): el LLM mandó a out_of_scope
    // "desde Tegucigalpa, son 10 adultos 1 niño, del 7 al 9 de agosto" y luego un
    // "Ceiba" suelto (dos veces) — ciudades NUESTRAS con un grupo que SÍ alojamos
    // (7-12 → gemelas de Tela). Si el mensaje nombra una ciudad en alcance, o el
    // contexto trae un grupo de 7+, la clasificación se IGNORA y el mensaje sigue
    // al flujo normal (merge → fechas → routing de grupos → auto-asignación).
    const cityNamed = cityFromText(text) ?? botResult.extractedData.city ?? null;
    const guestsCtx = botResult.extractedData.guests ?? previousData.guests ?? null;
    const inScopeSignal =
      cityNamed !== null ||
      botResult.extractedData.property != null ||
      (typeof guestsCtx === "number" && guestsCtx >= 7);

    if (!inScopeSignal) {
      // out_of_scope legítimo → declinar + reenfocar. Guardia anti-repetición:
      // nunca el MISMO texto dos veces seguidas (firma "bot pegado"); la segunda
      // vez va la variante corta que pide la zona.
      const lastRule = await getLastOutRule(phone, env.DB);
      const msg =
        lastRule === "out_of_scope_redirect"
          ? T.outOfScopeAgain(lang)
          : lang === "en"
            ? "For now we focus on La Ceiba, Tela and Tegucigalpa, so we don't have that option 🙏. But I'd be glad to help you find something in one of those areas — tell me how many guests and which dates and I'll show you the best fit."
            : "Por ahora nos enfocamos en La Ceiba, Tela y Tegucigalpa, así que no contamos con esa opción 🙏. Pero con gusto te ayudo a encontrar algo en una de esas zonas — contame para cuántas personas y qué fechas y te muestro lo que mejor les calce.";
      return {
        reply:           msg,
        escalateToOwner: false,
        ruleName:        "out_of_scope_redirect",
        tokensUsed:      botResult.tokensUsed,
      };
    }
    // Señal en alcance con intent=out_of_scope: la regla 4 del prompt le ordena al
    // LLM anular los datos al declinar → restauramos la ciudad detectada para que
    // el merge de abajo la conserve, y marcamos el override para que la respuesta
    // final sea determinística (el reply del LLM acá es el texto de declinación).
    overrodeOutOfScope = true;
    if (cityNamed && botResult.extractedData.city == null) {
      botResult.extractedData.city = cityNamed;
    }
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

  // ── Parser DETERMINÍSTICO de fechas (date-parser.ts) — la ÚLTIMA palabra ───────
  // El LLM aporta su ISO tentativo; acá lo VALIDAMOS/CORREGIMOS con código puro:
  // "mañana"=hoy+1, "17 de julio"=año correcto (nunca el pasado), noches solo de
  // "noches/días/semana" (jamás de personas), check-out > check-in. Esto saca de la
  // ecuación la clase de bugs más grande del bot (fechas mal razonadas por el LLM).
  // Blindado por __tests__/date-parser.test.ts — tocar la lógica sin romper esos casos.
  const resolved = resolveDates(text, mergedData.checkIn, mergedData.checkOut, todayIso);
  if (resolved.corrected) {
    // 📸 deja rastro para el dashboard de fallos (categoría: fechas que el parser tuvo que arreglar)
    try {
      await env.DB.prepare(
        `INSERT INTO bot_trace (phone, stage, detail) VALUES (?, 'DATE_PARSER_FIX', ?)`,
      ).bind(phone, JSON.stringify({
        from: { in: mergedData.checkIn, out: mergedData.checkOut },
        to:   { in: resolved.checkIn,   out: resolved.checkOut },
        text: text.slice(0, 200),
      })).run();
    } catch { /* best-effort, nunca bloquear la respuesta */ }
  }
  mergedData.checkIn = resolved.checkIn;
  mergedData.checkOut = resolved.checkOut;

  // ── Estadía LARGA por fechas (un mes+) → caso especial, NO cotizar por noche ──
  // Para una renta a largo plazo armamos una propuesta a medida (descuento mensual,
  // condiciones); la tarifa por noche × 142 no aplica, y la disponibilidad de 4 meses
  // casi siempre falla en Airbnb. Escalamos a César con un mensaje cálido. (Caso Vanina:
  // 11 jul → 30 nov.) Se detecta acá, ANTES de auto-asignar propiedad o cotizar.
  if (mergedData.checkIn && mergedData.checkOut && nightsBetween(mergedData.checkIn, mergedData.checkOut) >= LONG_TERM_NIGHTS) {
    return {
      reply:           T.longTermInquiry(lang),
      escalateToOwner: true,
      ruleName:        "long_term_inquiry",
      tokensUsed:      botResult.tokensUsed,
    };
  }

  // ── Routing determinístico de GRUPOS (caso Alisson, 7-jul-2026) ─────────────
  // Un grupo de 7-12 pidiendo La Ceiba o Tegucigalpa (donde las casas topan en 6)
  // NO es "no contamos con esa opción": la única que los aloja juntos son las
  // gemelas de Tela → se ofrece EN alcance, determinístico, sin pasar por el LLM.
  // >12 → honestidad con el tope (antes vivía solo como regla del prompt).
  // Solo dispara si ESTE turno aportó datos (guests/ciudad/propiedad nuevos) — un
  // "ok" suelto con un grupo viejo en el estado no debe repetir el mensaje.
  const turnBroughtData =
    botResult.extractedData.guests != null ||
    botResult.extractedData.city != null ||
    botResult.extractedData.property != null ||
    cityFromText(text) !== undefined;
  if (
    !mergedData.property &&
    typeof mergedData.guests === "number" &&
    turnBroughtData
  ) {
    if (mergedData.guests > 12) {
      await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
      return {
        reply:           T.groupTooBig(lang),
        escalateToOwner: false,
        ruleName:        "group_too_big",
        tokensUsed:      botResult.tokensUsed,
      };
    }
    if (
      mergedData.guests >= 7 &&
      (mergedData.city === "La Ceiba" || mergedData.city === "Tegucigalpa")
    ) {
      await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
      return {
        reply:           T.groupRedirectGemelas(lang, mergedData.guests, mergedData.city),
        escalateToOwner: false,
        ruleName:        "group_redirect_gemelas",
        tokensUsed:      botResult.tokensUsed,
      };
    }
  }

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
    // Pidió específicamente las HABITACIONES → fotos de dormitorios (si hay para esa
    // propiedad; si no —ej. Villa B11— cae a las fotos normales de abajo).
    const bedroomPhotos = isBedroomPhotoRequest(text) ? getBedroomPhotos(mergedData.property) : [];
    if (bedroomPhotos.length > 0) {
      await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
      const intro = lang === "en" ? "🛏️ Here are the bedrooms 📸" : "🛏️ Acá te van las habitaciones 📸";
      return {
        reply:           intro + T.photosGallery(lang, getGalleryUrl(mergedData.property)),
        images:          bedroomPhotos,
        escalateToOwner: false,
        ruleName:        "bedroom_photos_sent",
        tokensUsed:      botResult.tokensUsed,
      };
    }
    const photos = getPropertyPhotos(mergedData.property);
    if (photos.length > 0) {
      // Mantener el state con lo que sepamos para seguir el flujo después
      await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
      const galleryUrl = getGalleryUrl(mergedData.property);
      const card =
        buildPropertyCard(mergedData.property, lang) ||
        `${
          botResult.reply && botResult.reply.trim().length > 0
            ? botResult.reply.trim()
            : T.photosIntro(lang)
        }${T.photosGallery(lang, galleryUrl)}`;
      const pcBody =
        botResult.reply && botResult.reply.trim().length > 0
          ? botResult.reply.trim()
          : T.photosIntro(lang);
      return {
        reply: card,
        images: photos,
        productCard: { retailerId: mergedData.property, body: pcBody },
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

  // ── Cliente NOMBRA una propiedad nueva (early funnel) → mandar la TARJETA ──
  // visual (mejores fotos + precio + link) y, si solo mostró interés, pedirle
  // fechas/huéspedes. Engancha al lead (ej. de un ad de Casa Brisa) con lo que
  // vino a ver ANTES de pedirle tarea. Dispara una sola vez por propiedad: si
  // repite la misma no se reenvía; si ya cotizó o está pagando, no aplica.
  const namedNewProperty =
    ex.property != null && ex.property !== previousData.property;
  const earlyFunnel =
    previousState == null || previousState === "awaiting_quote_data";
  if (namedNewProperty && earlyFunnel && !isQuoteDataComplete(mergedData)) {
    const photos = getPropertyPhotos(mergedData.property!);
    const card = buildPropertyCard(mergedData.property!, lang);
    if (photos.length > 0 && card) {
      await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
      const needDates = !mergedData.checkIn || !mergedData.checkOut;
      const needGuests = !mergedData.guests;
      const ask =
        lang === "en"
          ? "To check availability and send you the exact price, just tell me " +
            (needDates && needGuests
              ? "your dates and how many guests"
              : needDates
                ? "your check-in and check-out dates"
                : "how many guests there'll be") +
            " 🗓️"
          : "Para verificar disponibilidad y pasarte el precio exacto, decime " +
            (needDates && needGuests
              ? "las fechas y cuántos serían"
              : needDates
                ? "las fechas de llegada y salida"
                : "cuántos serían en total") +
            " 🗓️";
      // Si además hizo una PREGUNTA puntual, respondela primero y sumá la
      // tarjeta como apoyo; si solo mostró interés, tarjeta + pedido de datos.
      const answered =
        botResult.intent === "asking_question" &&
        botResult.reply &&
        botResult.reply.trim().length > 0
          ? botResult.reply.trim() + "\n\n"
          : "";
      const reply = answered ? answered + card : card + "\n\n" + ask;
      return {
        reply,
        images:          photos,
        productCard:     { retailerId: mergedData.property!, body: answered ? answered.trim() : ask },
        escalateToOwner: false,
        ruleName:        "property_card_proactive",
        tokensUsed:      botResult.tokensUsed,
      };
    }
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
  // ── Red de seguridad anti "promesa vacía" ─────────────────────────────────
  // El LLM a veces dice "voy a verificar la disponibilidad… un momento" cuando le
  // FALTAN datos para cotizar (típico: dieron "hoy" pero no la salida/noches). Esa
  // promesa deja al cliente esperando algo que el bot NO puede hacer en segundo
  // plano → lead frío (caso Jflores). Si detectamos esa promesa Y los datos están
  // incompletos, la reemplazamos por un pedido DETERMINÍSTICO de lo que falta.
  const overPromise =
    /(un momento|dame un|dame unos|d[eé]jame (verific|revis|consult|chequ)|voy a (verific|revis|consult|chequ)|permit[ií]me|enseguida te|ya te confirmo|te confirmo en un|let me (check|verify)|one moment|hold on|give me a moment|i'?ll (check|verify))/i;
  // (overrodeOutOfScope: si arriba ignoramos un out_of_scope mal clasificado, el
  // reply del LLM es el texto de declinación — jamás se manda; va el pedido
  // determinístico de lo que falta.)
  if (!isQuoteDataComplete(mergedData) && (overrodeOutOfScope || overPromise.test(botResult.reply ?? ""))) {
    const miss = missingFields(mergedData);
    const parts: string[] = [];
    if (miss.propiedad) parts.push(lang === "en" ? "which property" : "qué propiedad");
    if (miss.fechas)
      parts.push(
        lang === "en"
          ? "the check-in and check-out dates (or how many nights)"
          : "las fechas de llegada y salida (o cuántas noches)",
      );
    if (miss.huespedes) parts.push(lang === "en" ? "how many guests" : "cuántos huéspedes");
    const list = parts.join(lang === "en" ? " and " : " y ");
    await upsertState(phone, "awaiting_quote_data", mergedData, env.DB);
    return {
      reply:
        lang === "en"
          ? `To check availability and send you the exact price, I just need ${list} 🗓️`
          : `Para verificar disponibilidad y pasarte el precio exacto, solo necesito ${list} 🗓️`,
      escalateToOwner: false,
      ruleName:        "ask_missing_after_overpromise",
      tokensUsed:      botResult.tokensUsed,
    };
  }

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
    // El cliente RECHAZA / no quiere reservar ("no me interesa", "es muy caro", "no
    // le he pedido ninguna reserva") → NO repetir el clarify (el bot lo machacaba 3
    // veces ignorando al cliente). Soltamos el embudo y cerramos cálido, con la
    // puerta abierta. (Caso real, 13-jun: lead perdido en un bucle de pago.)
    if (isNotInterested(text)) {
      await cancelQuoteFlow(phone, env.DB);
      return {
        reply: lang === "en"
          ? "No worries at all! 🙏 We're here whenever you need — if you'd like to book or see another option later, just message me. Have a great day!"
          : "¡Sin problema! 🙏 Quedamos a la orden — si más adelante querés reservar o ver otra opción, escribime con gusto. ¡Que tengás buen día!",
        escalateToOwner: false,
        ruleName:        "payment_declined",
        tokensUsed:      0,
      };
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
