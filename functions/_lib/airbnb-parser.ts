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

// Mapeo nombre EXACTO del listing en Airbnb → slug interno de atribución.
// Confirmado por César con captura de airbnb.com/hosting (2026-07-01). Estos son
// los ÚNICOS 5 listings que generan ingreso y deben respaldarse. Si Airbnb cambia
// el título de un listing, hay que actualizar aquí o el parser fallará al match
// (devuelve error claro "no está mapeado", no rompe nada).
//
// La comparación es tolerante al formato (ver NORMALIZED_LISTING_INDEX abajo):
// mayúsculas, espacios y guiones no rompen el match. Los dos "Paraíso Playero"
// se distinguen por el sufijo ", Honduras" (match exacto/normalizado, NO prefijo).
//
// Nota sobre `la-florida-1b`: César maneja La Florida como DOS unidades separadas
// en su contabilidad (1A y 1B). El sitio solo tiene el slug `la-florida` (= 1A),
// así que `la-florida-1b` es un slug de ATRIBUCIÓN: vive en la tabla reservations
// como etiqueta para no colapsar 1A+1B en el respaldo. No es una propiedad web
// completa (sin precio/foto/disponibilidad) — es intencional para el histórico.
export const AIRBNB_LISTING_TO_SLUG: Record<string, string> = {
  "Paraíso Playero: TelaBeachouse": "las-gemelas-tela",             // "Casa principal" (Tela) → Las Gemelas de Tela
  "Paraíso Playero: TelaBeachouse, Honduras": "casa-marea",         // (Tela) → Casa Marea / Paraíso Playero
  "La Casita del Mar": "casa-brisa",                                // (Tela) → Casa Brisa
  "Modern & Comfortable 1 BedRoom Apt": "la-florida",               // (Tegucigalpa) → La Florida 1A
  "Centrico- 2 Habitaciones - Comodo - Seguridad": "la-florida-1b", // (Tegucigalpa) → La Florida 1B (slug de atribución)
  "Business Stay-5 Star Location-Torre Morazan-Views": "centro-morazan", // (Tegucigalpa) → Centro Morazán
  "Casa 2 Hab - Hotel Palma Real-Piscina-Playa": "villa-b11-palma-real", // (La Ceiba) → Villa B11 en Hotel Palma Real
  //
  // Slugs de propiedad web válidos (quote-builder.ts): villa-b11-palma-real ·
  // casa-brisa · casa-marea · las-gemelas-tela · centro-morazan ·
  // casa-lara-townhouse · la-florida. `la-florida-1b` es solo de atribución.
  //
  // FUERA a propósito (no generan ingreso propio / no son de Jacarí): Casa en
  // Querètaro, Modern 2BR Apartment, Depto 2 hab (La Pradera), Casa Céntrica con
  // Gran Jardín, Modern & Luxurious 2 BedRoom, Townhouse-centrico, Lujosa Suite
  // Valle de Ángeles, Paraíso Playero2 (San Juan, sin publicar).
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
  /**
   * true si amountUsd cayó fuera del rango esperado (ver isAmountSuspicious).
   * NO bloquea la reserva (fechas/huésped son reales) pero la excluye del
   * sync a contabilidad hasta revisión manual — ver airbnb-reservation.ts.
   */
  amountFlagged?: boolean;
  /** Ciudad origen del huésped (ej. "Santo Domingo, República Dominicana"). */
  guestLocation?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Monto (GANAS) — parseo tolerante a formato + guardia de rango
// ─────────────────────────────────────────────────────────────────────────────
//
// Puerto a TypeScript de `parseMoney` en scripts/google-apps-script-airbnb-parser.gs
// (Apps Script no corre vitest, así que la lógica se testea acá — ver
// __tests__/airbnb-parser.test.ts). MANTENER AMBAS COPIAS IDÉNTICAS: si tocás
// una, tocá la otra y volvé a correr los tests de acá.
//
// Bug histórico ×100 (JACARI_MEMORY 2026-07-04): el parser viejo interpretaba
// la coma decimal como separador de miles ("232,80" → 23280). Regla correcta:
// el separador decimal es el ÚLTIMO seguido de EXACTAMENTE 2 dígitos; el resto
// son miles. Sin decimales ("80") → entero.
//
// SOLO acepta string (igual que el .gs, que solo la llama con una captura de
// regex): un `number` de JS pierde ceros finales al volverse string
// (`String(232.80)` === "232.8") y rompería la regla de "2 dígitos exactos".
// Nunca le pases un number ya parseado — para eso no hace falta parsear nada.
export function parseMoney(raw: string | null | undefined): number | undefined {
  const s = String(raw ?? "").replace(/[^\d.,]/g, "");
  if (!s) return undefined;
  const m = s.match(/[.,](\d{2})$/);
  if (m) {
    const intPart = s.slice(0, s.length - 3).replace(/[.,]/g, "");
    const n = parseFloat((intPart || "0") + "." + m[1]);
    return Number.isNaN(n) ? undefined : n;
  }
  const n = parseFloat(s.replace(/[.,]/g, ""));
  return Number.isNaN(n) ? undefined : n;
}

// Rango sano de un "Ganas" (payout por reserva) de Jacarí. Basado en los montos
// históricos reales (~$50-$600/reserva); generoso hacia arriba para no marcar
// estadías largas legítimas. Un ×100 real (ej. $77.22 → $7722) siempre cae muy
// por encima del máximo, así que esto lo atrapa aunque el parser se rompa de nuevo.
export const AIRBNB_AMOUNT_MIN_USD = 5;
export const AIRBNB_AMOUNT_MAX_USD = 2500;

/** true = amountUsd fuera de rango (posible bug de parseo). undefined (sin monto aún) NO es sospechoso. */
export function isAmountSuspicious(amountUsd: number | undefined): boolean {
  if (amountUsd === undefined) return false;
  return amountUsd < AIRBNB_AMOUNT_MIN_USD || amountUsd > AIRBNB_AMOUNT_MAX_USD;
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
      amountFlagged: isAmountSuspicious(amountUsd),
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
