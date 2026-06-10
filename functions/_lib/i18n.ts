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

  existingGuest: (l: Lang): string =>
    l === "en"
      ? "Of course! Let me connect you with someone on our team who has access to your booking to help you right away. 🙏"
      : "¡Con gusto! Te conecto con alguien del equipo que tiene acceso a tu reserva para ayudarte enseguida. 🙏",

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

  // Cliente pide un número para llamar → darlo directo y amable (sin disculpas
  // ni recitar las ciudades; eso es para lo que SÍ está fuera de alcance).
  phoneContact: (l: Lang): string =>
    l === "en"
      ? "Of course! 📞 You can call or message us at +504 9764-9035. Happy to help with your booking here too!"
      : "¡Claro! 📞 Podés llamarnos o escribirnos al +504 9764-9035. ¡Con gusto te ayudo también por acá con tu reserva!",

  // "Último aviso" antes de cerrar la ventana de 24h — la fecha SIGUE disponible.
  lastCallAlive: (l: Lang, ref: string): string =>
    l === "en"
      ? `Hi! 👋 Before our chat closes here, I still have everything ready${ref}. Want to go ahead with the booking? If you'd prefer other dates, I can help too. 🌴`
      : `¡Hola! 👋 Antes de que se cierre nuestra conversación por acá, sigo teniendo todo listo${ref}. ¿Querés que avancemos con la reserva? Si preferís otras fechas, también te ayudo. 🌴`,

  // "Último aviso" cuando esas fechas YA NO están (ocupadas o ya pasaron) →
  // no insistir con eso; ponerse a la orden con otras fechas/opciones.
  lastCallUnavailable: (l: Lang, ref: string): string =>
    l === "en"
      ? `Hi! 👋 Quick heads-up — those dates${ref} are no longer available 😕, but I'd be glad to find you other dates or another option. Want me to? 🌴`
      : `¡Hola! 👋 Te cuento que esas fechas${ref} ya no están disponibles 😕, pero con gusto te busco otras fechas u otra opción. ¿Te ayudo? 🌴`,

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
