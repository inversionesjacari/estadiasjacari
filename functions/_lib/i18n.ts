/// <reference types="@cloudflare/workers-types" />
//
// i18n.ts — Mensajes determinísticos del bot en español e inglés.
//
// El bot conversacional (LLM) ya responde en el idioma del cliente. Pero los
// mensajes "fijos" (welcome, cotización, método de pago, transferencia, etc.)
// se arman en código, no por el LLM — por eso necesitan su versión bilingüe acá.
//
// El idioma del cliente se detecta en conversational-bot y se guarda en
// conversation_state.data.language ("es" | "en"). Default "es".
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { formatWindowHuman, type AltDates } from "./suggest-dates";

export type Lang = "es" | "en";

/** Normaliza cualquier valor a un Lang válido (default "es"). */
export function asLang(v: unknown): Lang {
  return v === "en" ? "en" : "es";
}

export const T = {
  welcome: (l: Lang): string =>
    l === "en"
      ? "Hello! Thanks for reaching out to Estadías Jacarí 🌴\n\nHow can we help you today?"
      : "¡Hola! Gracias por escribir a Estadías Jacarí 🌴\n\n¿En qué podemos servirte?",

  askPaymentMethod: (l: Lang, depositLine: string): string =>
    l === "en"
      ? `Awesome! 🎉 How would you like to pay the ${depositLine} deposit?\n\n💳 *Card or PayPal* — instant link, confirmed right away\n🏦 *Bank transfer* — BAC, I'll send you the details\n\nJust let me know which one.`
      : `¡Excelente! 🎉 ¿Cómo preferís pagar el depósito de ${depositLine}?\n\n💳 *Tarjeta o PayPal* — link inmediato, confirmás al instante\n🏦 *Transferencia bancaria* — BAC, te paso los datos\n\nDecime cuál preferís.`,

  paymentMethodClarify: (l: Lang): string =>
    l === "en"
      ? "Sorry, could you pick one option?\n\n💳 *Card* (PayPal, instant link)\n🏦 *Transfer* (BAC, I'll send details)"
      : "Disculpá, ¿podés elegir una opción?\n\n💳 *Tarjeta* (PayPal, link inmediato)\n🏦 *Transferencia* (BAC, te paso los datos)",

  unavailable: (l: Lang, propertyName: string): string =>
    l === "en"
      ? `Unfortunately ${propertyName} is not available for those dates 😔\n\nWould you like me to check other dates or another property?`
      : `Lamentablemente ${propertyName} no está disponible en esas fechas 😔\n\n¿Querés que revise otras fechas u otra propiedad?`,

  availabilityNote: (l: Lang): string =>
    l === "en"
      ? "\n\n⚠️ Let me confirm those dates are still open and I'll get right back to you."
      : "\n\n⚠️ Déjame confirmar que esas fechas sigan libres y te confirmo enseguida.",

  // Respuesta a "¿qué fechas tenés disponibles?" (pregunta INVERSA). El bot no puede
  // enumerar el calendario de forma confiable → pide un rango concreto para chequearlo
  // al instante. NUNCA dice "no puedo verificar" ni repite un "no disponible" viejo
  // (caso Carlos Meza, Villa B11). Sin 🌴: es neutral y sirve para cualquier zona.
  availabilityDatesAsk: (l: Lang, propertyName?: string): string => {
    const prop = propertyName ? (l === "en" ? ` for ${propertyName}` : ` de ${propertyName}`) : "";
    return l === "en"
      ? `Happy to check availability${prop}! 🗓️ Just tell me the exact dates you have in mind — your check-in and check-out — and I'll confirm right away whether they're open and the price. If you're flexible, send me a couple of options and I'll tell you which works.`
      : `¡Con gusto reviso la disponibilidad${prop}! 🗓️ Decime las fechas exactas que tenés en mente — el día de llegada y el de salida — y te confirmo al instante si están libres y el precio. Si tenés flexibilidad, pasame un par de opciones y te digo cuál te queda.`;
  },

  // Respuesta a "¿cuál es la capacidad / hasta cuántos caben?" — el bot da el CUPO
  // EXACTO de la propiedad (PROPERTY_PRICING.capacity), sin LLM y sin re-cotizar (bug
  // Méndez, Casa Brisa: re-mandaba la cotización en vez de contestar). Neutral (sin 🌴):
  // sirve para cualquier zona; el caller ya conoce la propiedad y su cupo.
  capacityAnswer: (l: Lang, propertyName: string, capacity: number): string =>
    l === "en"
      ? `${propertyName} sleeps up to *${capacity} guests* 👍 Want me to go ahead and lock in your dates?`
      : `${propertyName} admite hasta *${capacity} huéspedes* 👍 ¿Seguimos con la reserva?`,

  // "¿Está cerca del mar / a cuánto queda la playa?" para las propiedades de Tela: va
  // JUNTO con el croquis de Honduras Shores Plantation (la imagen la manda la intercepción
  // beach_proximity_map con images:[TELA_CROQUIS_URL]). Dato exacto de César: mar a 5-7 min
  // caminando + circuito cerrado con seguridad 24/7. 🌊/🌴 permitidos: es zona de playa.
  beachProximityTela: (l: Lang): string =>
    l === "en"
      ? "The sea is about a 5-7 minute walk, depending on your pace 🌊 The property is the one circled in red on the map: it's inside the villa complex of Hotel Honduras Shores Plantation, a private home in a gated community with 24/7 security. 🌴"
      : "El mar está a unos 5 a 7 minutos caminando, dependiendo del ritmo 🌊 La propiedad es la que está circulada en rojo en el mapa: está dentro del complejo de villas del Hotel Honduras Shores Plantation, una propiedad privada en un circuito cerrado con seguridad 24/7. 🌴",

  // Propiedad NO disponible en las fechas pedidas, pero el bot BUSCÓ en el calendario
  // y PROPONE (en vez de solo "no disponible, ¿otras fechas?" y esperar → lead frío):
  // (1) la ventana libre MÁS CERCANA a lo pedido y (2) otros FINES DE SEMANA libres.
  // Las fechas vienen de findAlternativeDates (suggest-dates.ts), que lee el MISMO
  // origen (getBlockedDates: iCal + D1) con el que el bot decidió "no disponible" →
  // son tan confiables como la cotización misma. beach: 🌴 solo en playa (Tela/La
  // Ceiba), nunca Tegucigalpa. El caller garantiza que hay al menos una alternativa.
  unavailableWithAlternatives: (
    l: Lang,
    propertyName: string,
    alt: AltDates,
    beach: boolean,
  ): string => {
    const tail = beach ? " 🌴" : "";
    const lines: string[] = [];
    if (alt.nearest) {
      lines.push(
        l === "en"
          ? `📅 Closest to your dates: *${formatWindowHuman(alt.nearest, l)}*`
          : `📅 Lo más cercano a tus fechas: *${formatWindowHuman(alt.nearest, l)}*`,
      );
    }
    for (const w of alt.weekends) {
      lines.push(
        l === "en"
          ? `🗓️ Free weekend: *${formatWindowHuman(w, l)}*`
          : `🗓️ Fin de semana libre: *${formatWindowHuman(w, l)}*`,
      );
    }
    if (lines.length === 0) {
      // Red de seguridad: sin alternativas, el mensaje genérico (no debería pasar).
      return l === "en"
        ? `Unfortunately ${propertyName} isn't available for those dates 😔\n\nWould you like me to check other dates or another property?`
        : `Lamentablemente ${propertyName} no está disponible en esas fechas 😔\n\n¿Querés que revise otras fechas u otra propiedad?`;
    }
    const body = lines.join("\n");
    return l === "en"
      ? `Ah, ${propertyName} isn't free for those exact dates 😔 — but I checked the calendar and here's what's open:\n\n${body}\n\nWant me to hold any of these? I can also check another property if you'd prefer.${tail}`
      : `Uy, ${propertyName} no está libre en esas fechas exactas 😔 — pero te busqué en el calendario y esto sí tengo abierto:\n\n${body}\n\n¿Te aparto alguna? También puedo ver otra propiedad si preferís.${tail}`;
  },

  paypalLink: (
    l: Lang,
    depositHnl: string,
    depositUsd: string,
    approvalUrl: string,
    balanceHnl: string,
  ): string =>
    l === "en"
      ? `Done! The 50% deposit is HNL ${depositHnl} (≈ USD ${depositUsd}). Pay here:\n\n👉 ${approvalUrl}\n\nOnce the payment goes through you'll automatically get your booking confirmation by email ✅\n\nThe balance (HNL ${balanceHnl}) is paid on arrival — that day, once the full payment has been received, we'll send you the check-in instructions. 🌴`
      : `¡Listo! El 50% de depósito es HNL ${depositHnl} (≈ USD ${depositUsd}). Pagás acá:\n\n👉 ${approvalUrl}\n\nAl confirmar el pago recibís automáticamente tu confirmación de reserva por correo ✅\n\nEl saldo (HNL ${balanceHnl}) se paga el día de llegada — ese día, al completar el pago, te compartimos las instrucciones de check-in. 🌴`,

  // Depósito (50%) por PayPal capturado (bot WhatsApp) → fechas RESERVADAS.
  // Espejo de transferDatesConfirmed: la info de ingreso se comparte el día del
  // check-in una vez recibido el pago TOTAL (política de la casa — receipt.ts).
  // Antes esta rama prometía instrucciones T-1 con solo la mitad pagada.
  paypalDepositReceived: (
    l: Lang,
    o: { propertyName: string; checkIn: string; checkOut: string; guests: number },
  ): string =>
    l === "en"
      ? `Payment received! ✅ Your dates at ${o.propertyName} are *reserved*.\n\n📅 From ${o.checkIn} to ${o.checkOut}\n👥 ${o.guests} guest${o.guests > 1 ? "s" : ""}\n\nThe remaining 50% is paid on your check-in day — that day, once the full payment has been received, we'll share everything you need to get in (WiFi, address, access).\n📧 Your official confirmation is on its way by email. Thanks for booking with us! 🙏`
      : `¡Pago recibido! ✅ Tus fechas en ${o.propertyName} quedaron *reservadas*.\n\n📅 Del ${o.checkIn} al ${o.checkOut}\n👥 ${o.guests} huésped${o.guests > 1 ? "es" : ""}\n\nEl saldo del 50% se paga el día de tu check-in — ese día, una vez recibida la totalidad del pago, te compartimos toda la información para tu ingreso (WiFi, dirección, accesos).\n📧 Tu confirmación oficial va en camino por correo. ¡Gracias por reservar con nosotros! 🙏`,

  // El pago entró pero OTRA reserva tomó esas fechas primero (carrera) → refund
  // automático + invitación a buscar otras fechas.
  paypalOverlapRefunded: (l: Lang, propertyName: string): string =>
    l === "en"
      ? `We're so sorry 😔 — right while your payment was processing, someone else took those exact dates at ${propertyName}. Your payment was refunded automatically (it can take 3–5 business days to show up).\n\nIf you'd like, tell me other dates and I'll check availability right away 🙏`
      : `Lo sentimos muchísimo 😔 — justo mientras se procesaba tu pago, otra persona tomó esas mismas fechas en ${propertyName}. Tu pago fue reembolsado automáticamente (puede tardar 3–5 días hábiles en reflejarse).\n\nSi querés, decime otras fechas y te reviso la disponibilidad al momento 🙏`,

  // El pago entró pero el registro de la reserva falló (error D1) → NO afirmar
  // "reservado" en falso; el equipo lo termina a mano (sale alerta a dueños).
  paypalReceivedRegisterPending: (l: Lang): string =>
    l === "en"
      ? "Payment received! ✅ We're finishing the registration of your booking — our team will confirm it with you shortly. 🙏"
      : "¡Pago recibido! ✅ Estamos terminando de registrar tu reserva — nuestro equipo te la confirma en un momentito. 🙏",

  paypalFallbackToTransfer: (l: Lang): string =>
    l === "en"
      ? "There was an issue generating the PayPal link. Here are the bank transfer details:\n\n"
      : "Hubo un problema generando el link de PayPal. Te paso los datos de transferencia:\n\n",

  paypalPendingReminder: (l: Lang): string =>
    l === "en"
      ? "I'm waiting for the payment confirmation from PayPal. Once it's processed you'll get your confirmation automatically. If you'd rather switch to a bank transfer, just say *transfer*."
      : "Estoy esperando la confirmación del pago desde PayPal. Una vez procesado, recibís la confirmación automáticamente. Si preferís cambiar a transferencia, decime *transferencia*.",

  paypalUsdRequested: (l: Lang): string =>
    l === "en"
      ? "Let me connect you with an agent who can give you the USD account. 🙏"
      : "Te conecto con un agente que te da la cuenta en USD. 🙏",

  transferProofReceived: (l: Lang): string =>
    l === "en"
      ? "Got your payment confirmation. An agent is reviewing it and will confirm your booking shortly. 🙏"
      : "Recibí tu comprobante. Un agente lo revisa y confirma tu reserva en breve. 🙏",

  // Comprobante de DEPÓSITO (50%+) verificado por el bot → fechas confirmadas, pero
  // la info de check-in queda para el día del ingreso, una vez completado el pago.
  transferDatesConfirmed: (l: Lang): string =>
    l === "en"
      ? "All set! ✅ We received your payment and your dates are *confirmed*. On your check-in day we'll share all the information you need to get in, once the full payment has been received. Thanks for booking with us! 🙏"
      : "¡Listo! ✅ Recibimos tu pago y tus fechas quedaron *confirmadas*. El día de tu check-in te compartimos toda la información para tu ingreso, una vez recibida la totalidad del pago. ¡Gracias por reservar con nosotros! 🙏",

  // Comprobante por el TOTAL (pago completo) verificado → reserva confirmada.
  transferFullConfirmed: (l: Lang): string =>
    l === "en"
      ? "All set! ✅ We received your full payment and your booking is *confirmed*. On your check-in day we'll send you everything you need to get in. Thanks for choosing us! 🙏"
      : "¡Listo! ✅ Recibimos tu pago completo y tu reserva quedó *confirmada*. El día de tu check-in te compartimos toda la información para tu ingreso. ¡Gracias por elegirnos! 🙏",

  // El bot no pudo verificar el comprobante con certeza → lo valida una persona.
  transferReceiptReview: (l: Lang): string =>
    l === "en"
      ? "Got it! 🙏 We're verifying your payment and we'll confirm your booking in just a moment."
      : "¡Recibido! 🙏 Estamos validando tu comprobante y en un momentito te confirmamos la reserva.",

  // El mismo comprobante (misma referencia) ya se había recibido antes.
  transferReceiptDuplicate: (l: Lang): string =>
    l === "en"
      ? "We'd already received this receipt 🙏. If you made another transfer, send me that photo; if it's the same one, you're all set!"
      : "Este comprobante ya lo habíamos recibido 🙏. Si hiciste otra transferencia, mandame esa foto; si es la misma, ¡ya está todo en orden!",

  existingGuest: (l: Lang): string =>
    l === "en"
      ? "Of course! Let me connect you with someone on our team who has access to your booking to help you right away. 🙏"
      : "¡Con gusto! Te conecto con alguien del equipo que tiene acceso a tu reserva para ayudarte enseguida. 🙏",

  // Estadía a LARGO PLAZO (un mes+) → es un caso a evaluar/negociar → lo toma el equipo.
  longTermInquiry: (l: Lang): string =>
    l === "en"
      ? "How nice that you'd like a longer stay! 🙌 For long-term stays we put together a custom proposal — I'm connecting you with our team and they'll reach out shortly to work out the details with you. 🙏"
      : "¡Qué bueno que quieras quedarte una temporada larga! 🙌 Para estadías largas armamos una propuesta a tu medida — te paso con nuestro equipo y te contactan en breve para coordinar los detalles. 🙏",

  // EVENTOS (Valle de Ángeles): el bot no cotiza eventos — junta los 3 datos clave
  // en UNA pregunta y en el siguiente turno deriva al equipo (eventHandoff).
  eventIntake: (l: Lang): string =>
    l === "en"
      ? "How exciting! 🎉 Our venue in Valle de Ángeles is perfect for special celebrations. So our events team can put together a proposal for you, tell me:\n\n1️⃣ What kind of event is it? (wedding, birthday, corporate…)\n2️⃣ Around what date?\n3️⃣ Roughly how many guests?"
      : "¡Qué emoción! 🎉 Nuestro espacio en Valle de Ángeles es ideal para celebraciones especiales. Para que nuestro equipo de eventos te arme una propuesta, contame:\n\n1️⃣ ¿Qué tipo de evento es? (boda, cumpleaños, corporativo…)\n2️⃣ ¿Para qué fecha aproximada?\n3️⃣ ¿Cuántas personas estiman?",

  eventHandoff: (l: Lang): string =>
    l === "en"
      ? "Perfect, thank you! 🙌 I've passed your info to our events team — they'll write to you right here shortly to put together a proposal made just for you. 🌿"
      : "¡Perfecto, mil gracias! 🙌 Ya le pasé tu información a nuestro equipo de eventos — te van a escribir por acá en breve para armarte una propuesta a tu medida. 🌿",

  // PAQUETES de marketing (9-jul-2026). "Family pack"/"Love Trip" (Villa B11):
  // precio fijo, se puede comunicar directo. "Friends Trip" (Las Gemelas + day
  // pass): el precio varía por adultos/niños y día de semana — se pide el
  // desglose para calcularlo bien (caso real Karen López, 10-jul-2026).
  packageVillaB11Fixed: (l: Lang): string =>
    l === "en"
      ? "Awesome, that offer is our Villa B11 package at Hotel Palma Real 🏝️\n\n2 nights · full hotel access included for your whole group (2 or 6 guests, same price) · *L.5,400*\n\nWhat dates are you thinking of?"
      : "¡Genial! Esa oferta es nuestro paquete de Villa B11 en Hotel Palma Real 🏝️\n\n2 noches · acceso completo al hotel incluido para todo tu grupo (sean 2 o 6 personas, el precio no cambia) · *L.5,400*\n\n¿Para qué fechas estás pensando?",

  packageFriendsTripIntake: (l: Lang): string =>
    l === "en"
      ? "Awesome! 🌊 That offer is our Friends Trip: 2 nights at Las Gemelas (Tela) + a day pass to Hotel Honduras Shores Plantation. The day pass price depends on your group, so tell me:\n\n1️⃣ How many adults and how many kids? (babies are free)\n2️⃣ What dates are you thinking of?"
      : "¡Genial! 🌊 Esa oferta es nuestro Friends Trip: 2 noches en Las Gemelas (Tela) + day pass al Hotel Honduras Shores Plantation. El precio del day pass depende del grupo, así que contame:\n\n1️⃣ ¿Cuántos adultos y cuántos niños son? (los bebés no cuentan)\n2️⃣ ¿Para qué fechas estás pensando?",

  packageNeedPartyBreakdown: (l: Lang): string =>
    l === "en"
      ? "To calculate the day pass correctly I need the breakdown, not just the total — how many *adults* and how many *kids* are going? (babies are free) 🙏"
      : "Para calcular bien el day pass necesito el desglose, no solo el total — ¿cuántos *adultos* y cuántos *niños* van? (los bebés no cuentan) 🙏",

  // Variante de REINTENTO del desglose: solo cuando lo último que dijo el bot ya
  // fue pedir el desglose y no le entendimos la respuesta — repetir la misma
  // pregunta verbatim lee robótico ("ya te dije"); un ejemplo concreto del formato
  // destraba. (Caso D'Karoll parte 2, 11-jul-2026.)
  packageNeedPartyBreakdownRetry: (l: Lang): string =>
    l === "en"
      ? "Almost there! 🙏 Send it to me like this, for example: *2 adults and 3 kids (ages 12, 9 and 7)* — babies are free and don't count. With that I'll send you the exact total right away."
      : "¡Ya casi! 🙏 Escribímelo así, por ejemplo: *2 adultos y 3 niños (de 12, 9 y 7 años)* — los bebés van gratis y no cuentan. Con eso te paso el total exacto enseguida.",

  paymentReported: (l: Lang): string =>
    l === "en"
      ? "Perfect! 🙏 Let me verify the payment with the team and we'll confirm your booking right away."
      : "¡Perfecto! 🙏 Déjame verificar el pago con el equipo y te confirmamos la reserva enseguida.",

  photosIntro: (l: Lang): string =>
    l === "en" ? "Sure! Here are some photos 📸" : "¡Claro! Te mando algunas fotos 📸",

  photosGallery: (l: Lang, galleryUrl: string): string =>
    l === "en"
      ? `\n\nSee all the photos here 👇\n${galleryUrl}`
      : `\n\nMirá todas las fotos acá 👇\n${galleryUrl}`,

  // Recordatorio del paso de pago tras atender una pregunta (fotos, etc.) cuando
  // el cliente ya estaba eligiendo método. Sin emoji de playa (aplica a toda zona).
  resumePaymentTail: (l: Lang): string =>
    l === "en"
      ? "\n\nWhenever you're ready, just tell me *Card* or *Transfer* and we'll continue."
      : "\n\nCuando la veas y estés lista, decime *Tarjeta* o *Transferencia* y seguimos.",

  // Cliente pregunta por el HORARIO de check-in / check-out ("a qué hora puedo
  // entrar", "entradas y salidas", "horario"). El dato es FIJO (3 PM / 11 AM, todas
  // las propiedades) pero los pasos determinísticos de pago se TRAGABAN la pregunta
  // (caso Sandra, 12-jun: la repitió 3 veces eligiendo método / esperando comprobante
  // y el bot la ignoró). El "tail" que retoma el paso de pago lo agrega quote-flow.
  checkinSchedule: (l: Lang): string =>
    l === "en"
      ? "🕒 Check-in is at *3:00 PM* and check-out at *11:00 AM* (applies to all our stays). Need to come in earlier or leave later? We'll do our best based on availability. On your check-in day I'll send you everything you need to get in."
      : "🕒 El check-in es a las *3:00 PM* y el check-out a las *11:00 AM* (aplica en todos nuestros alojamientos). ¿Necesitás entrar antes o salir más tarde? Lo vemos según disponibilidad. El día de tu ingreso te paso todas las instrucciones para entrar.",

  // Cliente pide un número para llamar → darlo directo y amable (sin disculpas
  // ni recitar las ciudades; eso es para lo que SÍ está fuera de alcance).
  phoneContact: (l: Lang): string =>
    l === "en"
      ? "Of course! 📞 You can call or message us at +504 9764-9035. Happy to help with your booking here too!"
      : "¡Claro! 📞 Podés llamarnos o escribirnos al +504 9764-9035. ¡Con gusto te ayudo también por acá con tu reserva!",

  // Cliente con miedo a estafa / duda de legitimidad ("¿son reales?", "¿cómo
  // confirmo su veracidad?", "¿es seguro pagar?") — la objeción más cara JUSTO
  // antes de transferir. Se responde con PRUEBAS reales (empresa registrada +
  // redes con historial + Airbnb con reseñas), cálido y sin ponerse a la
  // defensiva. El "tail" que retoma el paso de pago lo agrega quote-flow.
  trustReassurance: (l: Lang): string =>
    l === "en"
      ? "Totally understandable to want to make sure before paying 🙏\n\nWe're *Inversiones Jacarí S. de R.L.*, a registered company in Honduras — the transfer goes to the company's bank account, not a personal one. You can also check us out here:\n📸 Instagram: instagram.com/estadiasjacari\n🌐 estadiasjacari.com\n⭐ We're on Airbnb too, with real guest reviews.\n\nAnd you're welcome to call us anytime at +504 9764-9035."
      : "¡Totalmente entendible querer confirmar antes de transferir! 🙏\n\nSomos *Inversiones Jacarí S. de R.L.*, una empresa registrada en Honduras — la transferencia va a la cuenta de la empresa, no a una personal. También podés vernos acá:\n📸 Instagram: instagram.com/estadiasjacari\n🌐 estadiasjacari.com\n⭐ Estamos en Airbnb, con reseñas reales de huéspedes.\n\nY cuando quieras, podés llamarnos al +504 9764-9035.",

  // "Último aviso" antes de cerrar la ventana de 24h — la fecha SIGUE disponible.
  // 🌴 SOLO para zona de playa (Tela / La Ceiba). Tegucigalpa es ciudad → sin palmera
  // (era el caso Franci: "sigo teniendo todo listo en Tegucigalpa 🌴").
  lastCallAlive: (l: Lang, ref: string, beach: boolean): string =>
    l === "en"
      ? `Hi! 👋 Before our chat closes here, I still have everything ready${ref}. Want to go ahead with the booking? If you'd prefer other dates, I can help too.${beach ? " 🌴" : ""}`
      : `¡Hola! 👋 Antes de que se cierre nuestra conversación por acá, sigo teniendo todo listo${ref}. ¿Querés que avancemos con la reserva? Si preferís otras fechas, también te ayudo.${beach ? " 🌴" : ""}`,

  // "Último aviso" cuando esas fechas YA NO están (ocupadas o ya pasaron) →
  // no insistir con eso; ponerse a la orden con otras fechas/opciones.
  lastCallUnavailable: (l: Lang, ref: string, beach: boolean): string =>
    l === "en"
      ? `Hi! 👋 Quick heads-up — those dates${ref} are no longer available 😕, but I'd be glad to find you other dates or another option. Want me to?${beach ? " 🌴" : ""}`
      : `¡Hola! 👋 Te cuento que esas fechas${ref} ya no están disponibles 😕, pero con gusto te busco otras fechas u otra opción. ¿Te ayudo?${beach ? " 🌴" : ""}`,

  // Despedida cálida ÚNICA cuando el cliente cierra ("ya no gracias", "no gracias").
  // Determinística (siempre el mismo texto) → un acuse posterior ("ok") se silencia
  // en quote-flow en vez de repetir esta frase. Sin 🌴 (aplica a cualquier zona).
  farewell: (l: Lang): string =>
    l === "en"
      ? "Thanks for reaching out! 🙏 I'm here whenever you need anything — have a great day! 😊"
      : "¡Gracias por escribirnos! 🙏 Aquí estoy cuando gustés. ¡Que tengás un buen día! 😊",

  // Cliente con intención de reservar que POSTERGA ("le confirmo la otra semana").
  // En vez del genérico "cuando estés listo, escribime", informa + motiva: las fechas
  // se apartan SOLO con el depósito y no se garantizan (orden de llegada), y que
  // escriba ANTES de depositar para confirmar disponibilidad (evita depositar a ciegas
  // y el reembolso si ya estaba tomada). Decisión de César 2026-06-11.
  postponeReminder: (l: Lang): string =>
    l === "en"
      ? "Of course, take the time you need! 😊 Just a heads-up: dates are only held on our calendar *once the deposit is made* — without it we can't guarantee they'll still be open, since they go on a first-come basis. So when you're ready, message me *before* sending the deposit and we'll confirm they're still available to lock them in. I'm here whenever you decide!"
      : "¡Claro, tomate el tiempo que necesités! 😊 Solo para que lo tengas en cuenta: las fechas se apartan en nuestro calendario *únicamente con el depósito* — sin él no podemos garantizar que sigan libres, porque se reservan por orden de llegada. Así que cuando estés lista, escribime *antes de depositar* y confirmamos que sigan disponibles para apartarlas. ¡Acá estoy cuando decidás!",

  // Grupo de 7–12 pidiendo una ciudad donde nuestras casas topan en 6 (La Ceiba /
  // Tegucigalpa): la ÚNICA opción que los aloja juntos son las gemelas de Tela.
  // Caso Alisson (7-jul): 11 personas + "Ceiba" terminaba en out_of_scope. Redirigir
  // EN alcance, sin declinar. 🌴 permitido: la oferta es Tela (playa).
  groupRedirectGemelas: (l: Lang, guests: number, city: string | null): string =>
    l === "en"
      ? `For ${guests} people together, our one option is **Las Gemelas in Tela**: Casa Brisa and Casa Marea, two beachfront houses side by side rented together (up to 12 guests) 🌴${city ? ` In ${city} our homes host up to 6.` : ""}\n\nWould Tela work for you? Say yes and I'll check availability right away.`
      : `Para ${guests} personas juntas, nuestra única opción es **Las Gemelas en Tela**: Casa Brisa y Casa Marea, dos casas a la par frente al mar que se rentan juntas (hasta 12 personas) 🌴${city ? ` En ${city} nuestras casas alojan hasta 6.` : ""}\n\n¿Les sirve Tela? Decime que sí y te reviso la disponibilidad al toque.`,

  // Grupo que supera el tope absoluto (12). Honestidad con calidez; preguntar si
  // pueden entrar en 12 en vez de recitar ciudades (no es tema de zona).
  groupTooBig: (l: Lang): string =>
    l === "en"
      ? "For groups that size, the most we can host is **12 people** (our two twin beachfront houses in Tela, rented together) 🌴 Any chance the group could fit in 12? If so, I'd be glad to check dates for you."
      : "Para grupos así de grandes, el máximo que manejamos son **12 personas** (las dos casas gemelas de Tela juntas, frente al mar) 🌴 ¿Habría chance de que el grupo entre en 12? Si sí, con gusto te reviso fechas.",

  // Variante corta del "fuera de alcance" para NO repetir el mismo texto dos veces
  // seguidas (firma "bot pegado", caso Alisson: 3 veces idéntico).
  outOfScopeAgain: (l: Lang): string =>
    l === "en"
      ? "As I mentioned, that one we don't handle 🙏 What we do have is La Ceiba, Tela and Tegucigalpa. Which of those works for you? Tell me guests and dates and I'll show you options."
      : "Como te contaba, eso no lo manejamos 🙏 Lo nuestro es La Ceiba, Tela y Tegucigalpa. ¿Cuál de esas zonas te queda mejor? Contame personas y fechas y te muestro opciones.",

  techError: (l: Lang): string =>
    l === "en"
      ? "Sorry, I had a technical issue processing your message. A team member will reply shortly. 🙏"
      : "Disculpa, tuve un problema técnico procesando tu mensaje. Un agente humano te responde en breve. 🙏",

  quoteBuildError: (l: Lang): string =>
    l === "en"
      ? "Sorry, there was a problem generating your quote. A team member will reply shortly. 🙏"
      : "Disculpa, hubo un problema generando tu cotización. Un agente te responde en breve. 🙏",

  reservationError: (l: Lang): string =>
    l === "en"
      ? "Oops, there was a problem processing your booking. An agent will assist you shortly. 🙏"
      : "Ups, hubo un problema procesando tu reserva. Un agente te asiste en breve. 🙏",
};
