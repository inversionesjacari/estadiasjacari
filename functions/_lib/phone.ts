/// <reference types="@cloudflare/workers-types" />
//
// Normalización de teléfonos a formato E.164 sin el '+' inicial — el shape
// que espera la WhatsApp Cloud API en el campo `to` (ej. "50488390145").
//
// Reglas:
//   - Quitar todo lo que no sea dígito (+, espacios, guiones, paréntesis).
//   - Si el número NO empieza con código de país, le ponemos 504 (Honduras)
//     por default. Si ya empieza con un código (504, 1, 52, 34, etc.) se
//     respeta tal cual.
//   - Honduras: 8 dígitos locales, código 504 → resultado de 11 dígitos.
//   - México: 10 dígitos locales, código 52 → resultado de 12 dígitos.
//
// El default a 504 cubre el 90% del caso real (huéspedes hondureños que
// dejan su número sin código). Si un huésped internacional puso su número
// completo con código, lo respetamos.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

const DEFAULT_COUNTRY_CODE = "504"; // Honduras

/** Códigos de país que reconocemos al inicio del número crudo. */
const KNOWN_COUNTRY_CODES = [
  "504", // Honduras
  "502", // Guatemala
  "503", // El Salvador
  "505", // Nicaragua
  "506", // Costa Rica
  "507", // Panamá
  "52",  // México
  "1",   // USA/Canadá
  "34",  // España
  "57",  // Colombia
];

export interface NormalizedPhone {
  /** Dígitos puros listos para WhatsApp Cloud API (ej. "50488390145"). */
  e164: string;
  /** True si reconocimos un código de país conocido al inicio. */
  hadCountryCode: boolean;
  /** El número original tal como vino (útil para logs). */
  original: string;
}

/**
 * Normaliza un teléfono crudo a E.164 sin '+'.
 *
 * Ejemplos:
 *   "+504 8839-0145"     → "50488390145"
 *   "8839-0145"          → "50488390145" (default Honduras)
 *   "(504) 88390145"     → "50488390145"
 *   "+1 (415) 555-1234"  → "14155551234"
 *   "  "                 → "" (vacío — no es número válido)
 */
export function normalizePhone(
  raw: string | null | undefined,
  opts: { assumeAlreadyE164?: boolean } = {},
): NormalizedPhone {
  const original = (raw ?? "").trim();
  // 1. Quitar todo lo que no sea dígito.
  const digits = original.replace(/\D+/g, "");
  if (!digits) {
    return { e164: "", hadCountryCode: false, original };
  }

  // 2. Caso ENTRANTE (msg.from de Meta): el número YA viene en E.164 completo
  //    con su código de país. NUNCA anteponer nada — si lo hiciéramos,
  //    corromperíamos números internacionales cuyo código no esté en la lista
  //    (ej. +39 Italia se volvía 504+39... y los mensajes fallaban al entregar).
  if (opts.assumeAlreadyE164) {
    return { e164: digits, hadCountryCode: true, original };
  }

  // 3. Detectar si empieza con código de país conocido.
  const matchedCode = KNOWN_COUNTRY_CODES.find((code) =>
    digits.startsWith(code),
  );
  if (matchedCode) {
    // El número ya trae código (504, 1, 52, etc.) — respetar.
    return { e164: digits, hadCountryCode: true, original };
  }

  // 4. Sin código conocido:
  //    - 8 dígitos exactos = número local hondureño → anteponer 504.
  //    - Más largo = probablemente internacional con código no listado →
  //      respetar tal cual (NO corromper anteponiendo 504).
  if (digits.length === 8) {
    return {
      e164: `${DEFAULT_COUNTRY_CODE}${digits}`,
      hadCountryCode: false,
      original,
    };
  }
  return { e164: digits, hadCountryCode: false, original };
}

/**
 * Validación mínima: WhatsApp exige al menos 8 dígitos totales y máximo 15
 * según el estándar E.164. Devuelve true si el número parece enviable.
 */
export function isValidE164(e164: string): boolean {
  return /^\d{8,15}$/.test(e164);
}
