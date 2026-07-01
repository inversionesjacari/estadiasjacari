/// <reference types="@cloudflare/workers-types" />
//
// Validación + normalización de payloads parseados de emails de Airbnb.
//
// El parsing del HTML/texto del email lo hace el Apps Script de Gmail
// (ver scripts/google-apps-script-airbnb-parser.gs) porque allí tiene
// acceso directo a los mensajes y es más fácil iterar el regex desde JS
// del editor de Apps Script.
//
// Este módulo en Cloudflare Pages solo:
//   1. Valida la shape del JSON que llega del Apps Script
//   2. Mapea el `listingName` de Airbnb a nuestro `slug` interno
//   3. Convierte fechas/montos a tipos correctos para D1
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

// Mapeo nombre exacto del listing en Airbnb → slug nuestro.
// César debe completar esta tabla con los nombres EXACTOS de sus 7 listings
// (los puede ver en airbnb.com/hosting). Si Airbnb cambia el nombre del
// listing, hay que actualizar aquí también o el parser fallará al match.
//
// Hint: el correo del 2026-05-29 que pasó César decía:
//   - "Modern & Comfortable 1 BedRoom Apt" → probablemente centro-morazan
//   - "Business Stay-5 Star Location-Torre Morazan-Views" → centro-morazan también?
// César debe confirmarlo.
export const AIRBNB_LISTING_TO_SLUG: Record<string, string> = {
  // Pendiente de completar con nombres EXACTOS. Ejemplo:
  // "Villa B11 — Hotel Palma Real, La Ceiba": "villa-b11-palma-real",
  // "Casa Brisa - Honduras Shores": "casa-brisa",
  // "Casa Marea - Honduras Shores": "casa-marea",
  // "Las Gemelas de Tela - HSP": "las-gemelas-tela",
  // "Modern & Comfortable 1 BedRoom Apt": "centro-morazan",
  // "Casa Lara Townhouse - Tegucigalpa": "casa-lara-townhouse",
  // "La Florida - Tegucigalpa": "la-florida",
  //
  // Slugs VÁLIDOS (deben coincidir EXACTO con los del sitio, ver quote-builder.ts):
  //   villa-b11-palma-real · casa-brisa · casa-marea · las-gemelas-tela
  //   centro-morazan · casa-lara-townhouse · la-florida
};

/**
 * Normaliza un nombre de listing para comparar de forma TOLERANTE al formato:
 * minúsculas, guiones unificados (– — → -), espacios colapsados y recortados.
 * Así un espacio de más, una capitalización distinta o un em-dash vs guion NO
 * rompen el match (era el riesgo #1 del parser: match exacto que falla por un
 * detalle invisible). NO quita acentos (podrían distinguir dos listings reales).
 */
export function normalizeListingName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[–—]/g, "-")       // en/em dash → guion normal
    .replace(/\s*-\s*/g, " - ")   // espaciado uniforme alrededor de guiones
    .replace(/\s+/g, " ")          // colapsar espacios múltiples
    .trim();
}

// Índice normalizado derivado del mapa canónico (arriba). Se reconstruye en cada
// import; el mapa es la fuente de verdad, este solo lo hace tolerante al formato.
const NORMALIZED_LISTING_INDEX: Record<string, string> = Object.fromEntries(
  Object.entries(AIRBNB_LISTING_TO_SLUG).map(([name, slug]) => [
    normalizeListingName(name),
    slug,
  ]),
);

export interface AirbnbReservationPayload {
  /** Nombre EXACTO del listing como aparece en Airbnb. */
  listingName: string;
  /** Código de confirmación Airbnb (ej. "HMXQAHMJ4P"). UNIQUE en D1. */
  confirmationCode: string;
  /** Nombre completo del huésped (ej. "Wander Jeremias Canelo Espinal"). */
  guestName: string;
  /** Fecha check-in en formato YYYY-MM-DD. */
  checkIn: string;
  /** Fecha check-out en formato YYYY-MM-DD. */
  checkOut: string;
  /** Cantidad de personas. */
  guestCount: number;
  /** Monto que pagó el huésped en USD. */
  amountUsd?: number;
  /** Ciudad origen del huésped (ej. "Santo Domingo, República Dominicana"). */
  guestLocation?: string;
}

export interface ValidationResult {
  ok: boolean;
  slug?: string;
  normalized?: AirbnbReservationPayload;
  errors?: string[];
}

export function validateAirbnbReservation(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["Payload no es objeto"] };
  }

  const p = raw as Record<string, unknown>;

  const listingName = typeof p.listingName === "string" ? p.listingName.trim() : "";
  if (!listingName) errors.push("listingName requerido");

  const confirmationCode = typeof p.confirmationCode === "string" ? p.confirmationCode.trim().toUpperCase() : "";
  if (!confirmationCode || !/^[A-Z0-9]{6,12}$/.test(confirmationCode)) {
    errors.push("confirmationCode inválido (esperado 6-12 chars alfanuméricos)");
  }

  const guestName = typeof p.guestName === "string" ? p.guestName.trim() : "";
  if (!guestName) errors.push("guestName requerido");

  const checkIn = typeof p.checkIn === "string" ? p.checkIn.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) {
    errors.push(`checkIn inválido: "${checkIn}" (esperado YYYY-MM-DD)`);
  }

  const checkOut = typeof p.checkOut === "string" ? p.checkOut.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    errors.push(`checkOut inválido: "${checkOut}" (esperado YYYY-MM-DD)`);
  }

  if (!errors.length && checkIn >= checkOut) {
    errors.push("checkIn debe ser anterior a checkOut");
  }

  const guestCount = Number(p.guestCount ?? 1);
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 50) {
    errors.push(`guestCount inválido: ${p.guestCount}`);
  }

  const amountUsd =
    p.amountUsd === undefined || p.amountUsd === null
      ? undefined
      : Number(p.amountUsd);
  if (amountUsd !== undefined && (!Number.isFinite(amountUsd) || amountUsd < 0)) {
    errors.push(`amountUsd inválido: ${p.amountUsd}`);
  }

  const guestLocation = typeof p.guestLocation === "string" ? p.guestLocation.trim() : undefined;

  if (errors.length) return { ok: false, errors };

  // Map listing → slug (tolerante al formato: espacios/mayúsculas/guiones)
  const slug =
    AIRBNB_LISTING_TO_SLUG[listingName] ??
    NORMALIZED_LISTING_INDEX[normalizeListingName(listingName)];
  if (!slug) {
    return {
      ok: false,
      errors: [
        `Listing name "${listingName}" no está mapeado en AIRBNB_LISTING_TO_SLUG. ` +
          `Editar functions/_lib/airbnb-parser.ts y agregar la entrada.`,
      ],
    };
  }

  return {
    ok: true,
    slug,
    normalized: {
      listingName,
      confirmationCode,
      guestName,
      checkIn,
      checkOut,
      guestCount,
      amountUsd,
      guestLocation,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mensaje entrante del huésped — intento de captura del teléfono
// ─────────────────────────────────────────────────────────────────────────────

export interface AirbnbMessagePayload {
  /** Código de confirmación de la reserva relacionada (HMxxx). */
  confirmationCode?: string;
  /** Nombre del huésped (fallback si no hay confirmationCode). */
  guestName?: string;
  /** Texto del mensaje que envió el huésped. */
  messageText: string;
}

/**
 * Extrae el primer número de teléfono del texto. Tolerante a formatos:
 *   "+504 9764-9035", "97649035", "504 9764-9035", "9764 9035", etc.
 *
 * NO usa libphonenumber por consistencia con phone.ts del proyecto.
 * Estrategia: encontrar secuencias de 8-15 dígitos (con separadores ignorados)
 * y devolver la primera que parezca teléfono real.
 */
export function extractPhoneFromText(text: string): string | null {
  if (!text || typeof text !== "string") return null;

  // Quitar caracteres no-dígito excepto los que típicamente separan teléfonos
  // y conservar el contexto. Luego escanear secuencias de dígitos.
  const cleaned = text.replace(/[\s\-\(\)\.]/g, "");

  // Match con + opcional + 8-15 dígitos
  const matches = cleaned.match(/\+?\d{8,15}/g);
  if (!matches || matches.length === 0) return null;

  // Devolver el primero (heurística MVP — si hay varios, agregar análisis después)
  return matches[0];
}
