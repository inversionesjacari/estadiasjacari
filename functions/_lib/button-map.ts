// functions/_lib/button-map.ts
//
// Botones nativos de WhatsApp (interactive reply buttons) para los 2 puntos de más
// fricción/misparse del flujo: elegir método de pago y confirmar la reserva.
//
// Regla de diseño (clave): un tap NO abre una rama de lógica nueva. El `id` del
// botón se MAPEA al texto canónico que los detectors (detectors.ts) YA reconocen, y
// fluye por el MISMO pipeline determinístico que quien escribe el texto. Así los
// botones bajan la fricción sin duplicar ni bifurcar la lógica, y quien escribe
// "tarjeta"/"reservar" a mano sigue funcionando igual (los detectors = fallback).
//
// Módulo PURO (sin I/O) para poder testear el ida-y-vuelta.

/** Ids estables de los botones (viajan en el payload de Meta, ida y vuelta). */
export const BTN = {
  PAY_CARD: "pay_card",
  PAY_TRANSFER: "pay_transfer",
  CONFIRM_BOOK: "confirm_book",
  CHANGE_DATES: "confirm_change_dates",
} as const;

// id entrante → texto canónico. Cada texto DEBE matchear un detector real:
//   tarjeta           → isCardChoice
//   transferencia     → isTransferChoice / isBankAccountRequest
//   quiero reservar   → isConfirmation (rama "quiero…reservar")
//   quiero cambiar…   → isConfirmation=false + isDateChangeOrAvailabilityQuestion → re-cotiza
// (El test round-trip verifica que estos textos sigan disparando esos detectors.)
const ID_TO_TEXT: Record<string, string> = {
  [BTN.PAY_CARD]: "tarjeta",
  [BTN.PAY_TRANSFER]: "transferencia",
  [BTN.CONFIRM_BOOK]: "quiero reservar",
  [BTN.CHANGE_DATES]: "quiero cambiar las fechas",
};

/** Forma del objeto `interactive` que manda Meta cuando el huésped TOCA un botón. */
export interface InteractiveInbound {
  type?: string;
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string };
}

/**
 * Convierte un tap de botón entrante al texto canónico que los detectors reconocen.
 * Devuelve null si no es un button_reply conocido (→ el webhook lo trata como el
 * resto de lo no-texto: escala a humano).
 */
export function buttonReplyToText(interactive: InteractiveInbound | null | undefined): string | null {
  if (!interactive) return null;
  const id = interactive.button_reply?.id ?? interactive.list_reply?.id;
  if (!id) return null;
  return ID_TO_TEXT[id] ?? null;
}

/** Un botón de respuesta rápida (Meta: máx 3 por mensaje; título ≤20 chars). */
export interface ButtonReply {
  id: string;
  title: string;
}

const isEn = (lang: string | null | undefined): boolean => String(lang ?? "").toLowerCase().startsWith("en");

/** Botones para elegir método de pago: [💳 Tarjeta] [🏦 Transferencia]. */
export function paymentButtons(lang: string): ButtonReply[] {
  return isEn(lang)
    ? [{ id: BTN.PAY_CARD, title: "💳 Card/PayPal" }, { id: BTN.PAY_TRANSFER, title: "🏦 Transfer" }]
    : [{ id: BTN.PAY_CARD, title: "💳 Tarjeta" }, { id: BTN.PAY_TRANSFER, title: "🏦 Transferencia" }];
}

/** Botones al presentar una cotización: [✅ Reservar] [📅 Cambiar fechas]. */
export function confirmButtons(lang: string): ButtonReply[] {
  return isEn(lang)
    ? [{ id: BTN.CONFIRM_BOOK, title: "✅ Book it" }, { id: BTN.CHANGE_DATES, title: "📅 Change dates" }]
    : [{ id: BTN.CONFIRM_BOOK, title: "✅ Reservar" }, { id: BTN.CHANGE_DATES, title: "📅 Cambiar fechas" }];
}
