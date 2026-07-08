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

  paypalLink: (
    l: Lang,
    depositHnl: string,
    depositUsd: string,
    approvalUrl: string,
    balanceHnl: string,
  ): string =>
    l === "en"
      ? `Done! The 50% deposit is HNL ${depositHnl} (≈ USD ${depositUsd}). Pay here:\n\n👉 ${approvalUrl}\n\nOnce the payment goes through you'll automatically get:\n✅ Booking confirmation by email\n📋 Check-in instructions\n\nThe balance (HNL ${balanceHnl}) is paid on arrival. 🌴`
      : `¡Listo! El 50% de depósito es HNL ${depositHnl} (≈ USD ${depositUsd}). Pagás acá:\n\n👉 ${approvalUrl}\n\nAl confirmar el pago recibís automáticamente:\n✅ Confirmación de reserva por correo\n📋 Instrucciones de check-in\n\nEl saldo (HNL ${balanceHnl}) se paga el día de llegada. 🌴`,

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
