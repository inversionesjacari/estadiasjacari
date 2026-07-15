/// <reference types="@cloudflare/workers-types" />
//
// followup-template.ts — Variables del template `seguimiento_cotizacion` (B4).
//
// El followup FUERA de la ventana de 24h solo puede salir por un template Meta
// aprobado. `seguimiento_cotizacion` tiene 3 variables de body:
//   {{1}} nombre · {{2}} propiedad · {{3}} fechas ("del 15 al 17 de agosto")
// más 2 botones quick-reply estáticos ("Sí, me interesa" / "Ya no, gracias") que
// NO llevan parámetros al enviar. Este módulo arma esas 3 variables desde el
// `data` del conversation_state. PURO (sin I/O) para testear el formato de fechas
// y la elegibilidad sin red.

import { PROPERTY_PRICING } from "./quote-builder";

const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Primer nombre limpio; si no hay, un neutro que lea natural en "Hola {{1}}". */
function firstName(guestName: string | null | undefined, lang: "es" | "en"): string {
  const first = (guestName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first) return first;
  return lang === "en" ? "there" : "de nuevo";
}

/**
 * Rango de fechas humano para {{3}}. checkIn/checkOut = YYYY-MM-DD.
 *   es: "del 15 al 17 de agosto" · "del 30 de agosto al 2 de septiembre"
 *   en: "Aug 15–17" · "Aug 30 – Sep 2"
 * Devuelve null si alguna fecha es inválida (el llamador salta ese lead).
 */
export function formatDateRangeEs(
  checkIn: string,
  checkOut: string,
  lang: "es" | "en",
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    return null;
  }
  const [, m1, d1] = checkIn.split("-").map(Number);
  const [, m2, d2] = checkOut.split("-").map(Number);
  if (!m1 || !d1 || !m2 || !d2 || m1 < 1 || m1 > 12 || m2 < 1 || m2 > 12) return null;

  const months = lang === "en" ? MONTHS_EN : MONTHS_ES;
  if (lang === "en") {
    const monShort = (m: number) => months[m - 1].slice(0, 3);
    return m1 === m2
      ? `${monShort(m1)} ${d1}–${d2}`
      : `${monShort(m1)} ${d1} – ${monShort(m2)} ${d2}`;
  }
  return m1 === m2
    ? `del ${d1} al ${d2} de ${months[m1 - 1]}`
    : `del ${d1} de ${months[m1 - 1]} al ${d2} de ${months[m2 - 1]}`;
}

export interface TemplateFollowupVars {
  name: string;      // {{1}}
  property: string;  // {{2}}
  dates: string;     // {{3}}
}

/**
 * Arma las 3 variables del template desde el estado del lead, o null si NO hay
 * datos suficientes (sin propiedad conocida o sin fechas válidas → el template
 * quedaría con huecos raros; mejor no mandarlo). El nombre viene del contacto.
 *
 * Todo en ESPAÑOL a propósito: el template `seguimiento_cotizacion` existe solo
 * en `es` (cuerpo español), así que formatear las variables en inglés para un
 * lead anglófono daría un mensaje mezclado ("Hola there … Aug 15–17" con botones
 * en español). Un followup 100% español es más coherente que uno bilingüe roto.
 * (Si algún día se sube una variante `en` del template, se ramifica acá.)
 */
export function buildTemplateFollowupVars(
  data: Record<string, unknown>,
  guestName: string | null | undefined,
): TemplateFollowupVars | null {
  const slug = typeof data.property === "string" ? data.property : null;
  const propName =
    slug && PROPERTY_PRICING[slug as keyof typeof PROPERTY_PRICING]
      ? PROPERTY_PRICING[slug as keyof typeof PROPERTY_PRICING].name
      : null;
  if (!propName) return null; // {{2}} sin propiedad conocida → no mandar

  const checkIn = typeof data.checkIn === "string" ? data.checkIn : null;
  const checkOut = typeof data.checkOut === "string" ? data.checkOut : null;
  if (!checkIn || !checkOut) return null;
  const dates = formatDateRangeEs(checkIn, checkOut, "es");
  if (!dates) return null; // fechas inválidas → no mandar

  return { name: firstName(guestName, "es"), property: propName, dates };
}
