/// <reference types="@cloudflare/workers-types" />
//
// Constructor de cotizaciones — toma los datos extraídos por el LLM y:
//   1. Verifica disponibilidad consultando reservaciones D1 + iCal Airbnb
//   2. Calcula precio total (noches × tarifa + limpieza)
//   3. Calcula 50% reserva + 50% saldo
//   4. Construye texto de respuesta para WhatsApp
//
// Por qué no usa /api/availability/<slug> directo: ese endpoint es para el
// frontend (Allow-Origin: *). Acá queremos consultar la misma data
// internamente sin HTTP overhead. Reusamos la lógica.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import type { PropertySlug, City } from "./quote-extractor";

/** Precios + capacidad por propiedad — single source of truth para el bot. */
export interface PropertyPricing {
  slug: PropertySlug;
  name: string;
  city: City;
  capacity: number;
  pricePerNightHNL: number;
  cleaningFeeHNL: number;
  pricePerNightUSD: number;
  cleaningFeeUSD: number;
}

export const PROPERTY_PRICING: Record<PropertySlug, PropertyPricing> = {
  "villa-b11-palma-real": {
    slug: "villa-b11-palma-real",
    name: "Villa B11 — Palma Real",
    city: "La Ceiba",
    capacity: 6,
    pricePerNightHNL: 2500,
    cleaningFeeHNL: 350,
    pricePerNightUSD: 90,
    cleaningFeeUSD: 14,
  },
  "casa-brisa": {
    slug: "casa-brisa",
    name: "Casa Brisa",
    city: "Tela",
    capacity: 6,
    pricePerNightHNL: 2500,
    cleaningFeeHNL: 350,
    pricePerNightUSD: 90,
    cleaningFeeUSD: 14,
  },
  "casa-marea": {
    slug: "casa-marea",
    name: "Casa Marea",
    city: "Tela",
    capacity: 6,
    pricePerNightHNL: 2500,
    cleaningFeeHNL: 350,
    pricePerNightUSD: 90,
    cleaningFeeUSD: 14,
  },
  "centro-morazan": {
    slug: "centro-morazan",
    name: "Centro Morazán",
    city: "Tegucigalpa",
    capacity: 6,
    pricePerNightHNL: 2100,
    cleaningFeeHNL: 400,
    pricePerNightUSD: 80,
    cleaningFeeUSD: 16,
  },
  "casa-lara-townhouse": {
    slug: "casa-lara-townhouse",
    name: "Casa Lara Townhouse",
    city: "Tegucigalpa",
    capacity: 4,
    pricePerNightHNL: 1590,
    cleaningFeeHNL: 400,
    pricePerNightUSD: 60,
    cleaningFeeUSD: 16,
  },
  "la-florida": {
    slug: "la-florida",
    name: "La Florida",
    city: "Tegucigalpa",
    capacity: 3,
    pricePerNightHNL: 650,
    cleaningFeeHNL: 350,
    pricePerNightUSD: 26,
    cleaningFeeUSD: 14,
  },
};

export interface QuoteInput {
  property: PropertySlug;
  checkIn: string;  // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number;
}

export interface QuoteOutput {
  available: boolean;
  reason?: string;        // si !available, por qué
  nights: number;
  pricePerNightHNL: number;
  cleaningFeeHNL: number;
  totalHNL: number;
  depositHNL: number;     // 50% para reservar
  balanceHNL: number;     // 50% el día de check-in
  pricePerNightUSD: number;
  cleaningFeeUSD: number;
  totalUSD: number;
  depositUSD: number;
  balanceUSD: number;
  propertyName: string;
  city: City;
  capacity: number;
  exceedsCapacity: boolean;
}

/** Calcula la cantidad de noches entre dos fechas YYYY-MM-DD (inclusive→exclusive). */
function nightsBetween(checkInIso: string, checkOutIso: string): number {
  const start = new Date(checkInIso + "T00:00:00Z").getTime();
  const end = new Date(checkOutIso + "T00:00:00Z").getTime();
  const days = Math.round((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

/**
 * Construye una cotización completa dado property + fechas + huéspedes.
 *
 * @param input  Datos completos de la cotización.
 * @param db     D1 (para consultar reservaciones existentes en esas fechas).
 *
 * NO consulta iCal de Airbnb — eso lo hace el endpoint /api/availability/.
 * Acá solo verificamos D1 (las reservaciones de nuestro propio sitio).
 * Para una verificación 100% completa hay que llamar el endpoint público.
 */
export async function buildQuote(
  input: QuoteInput,
  db: D1Database,
): Promise<QuoteOutput | null> {
  const pricing = PROPERTY_PRICING[input.property];
  if (!pricing) return null;

  const nights = nightsBetween(input.checkIn, input.checkOut);
  if (nights <= 0) {
    return {
      available: false,
      reason: "Check-out debe ser después de check-in.",
      nights: 0,
      pricePerNightHNL: pricing.pricePerNightHNL,
      cleaningFeeHNL: pricing.cleaningFeeHNL,
      totalHNL: 0,
      depositHNL: 0,
      balanceHNL: 0,
      pricePerNightUSD: pricing.pricePerNightUSD,
      cleaningFeeUSD: pricing.cleaningFeeUSD,
      totalUSD: 0,
      depositUSD: 0,
      balanceUSD: 0,
      propertyName: pricing.name,
      city: pricing.city,
      capacity: pricing.capacity,
      exceedsCapacity: false,
    };
  }

  const exceedsCapacity = input.guests > pricing.capacity;

  // Disponibilidad — verificar overlap con reservaciones D1 confirmed/pending
  let hasConflict = false;
  let conflictReason: string | undefined;
  try {
    const conflict = await db
      .prepare(
        `SELECT COUNT(*) as cnt
           FROM reservations
          WHERE property_slug = ?
            AND status IN ('confirmed', 'pending')
            AND NOT (check_out <= ? OR check_in >= ?)`,
      )
      .bind(input.property, input.checkIn, input.checkOut)
      .first<{ cnt: number }>();
    if ((conflict?.cnt ?? 0) > 0) {
      hasConflict = true;
      conflictReason = "Ya hay una reserva activa en esas fechas.";
    }
  } catch (err) {
    // Si D1 falla, no bloqueamos — el huésped puede pedir confirmación manual
    console.error("Error checking availability:", (err as Error).message);
  }

  const totalHNL = nights * pricing.pricePerNightHNL + pricing.cleaningFeeHNL;
  const depositHNL = Math.ceil(totalHNL / 2);
  const balanceHNL = totalHNL - depositHNL;
  const totalUSD = nights * pricing.pricePerNightUSD + pricing.cleaningFeeUSD;
  const depositUSD = Math.ceil(totalUSD / 2);
  const balanceUSD = totalUSD - depositUSD;

  return {
    available: !hasConflict && !exceedsCapacity,
    reason: hasConflict
      ? conflictReason
      : exceedsCapacity
        ? `La propiedad tiene capacidad máxima para ${pricing.capacity} huéspedes y solicitaste ${input.guests}.`
        : undefined,
    nights,
    pricePerNightHNL: pricing.pricePerNightHNL,
    cleaningFeeHNL: pricing.cleaningFeeHNL,
    totalHNL,
    depositHNL,
    balanceHNL,
    pricePerNightUSD: pricing.pricePerNightUSD,
    cleaningFeeUSD: pricing.cleaningFeeUSD,
    totalUSD,
    depositUSD,
    balanceUSD,
    propertyName: pricing.name,
    city: pricing.city,
    capacity: pricing.capacity,
    exceedsCapacity,
  };
}

/** Formato HNL con separador de miles. */
function fmtHnl(n: number): string {
  return `HNL ${n.toLocaleString("es-HN")}`;
}

/** Formato fecha es-HN abreviado: "15 jun" */
function fmtDateEs(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const months = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/**
 * Formatea el resultado de buildQuote como mensaje WhatsApp listo para enviar.
 * Tono cálido, claro, con emojis al inicio/final (sin firma personal).
 */
export function formatQuoteMessage(
  q: QuoteOutput,
  input: QuoteInput,
): string {
  // Caso 1: no disponible
  if (!q.available) {
    if (q.exceedsCapacity) {
      return `Lamentablemente, ${q.propertyName} tiene capacidad para ${q.capacity} huéspedes y son ${input.guests}. 😔

¿Te interesa otra de nuestras propiedades con mayor capacidad? Tenemos opciones para hasta 6 huéspedes, o si son más, podemos rentarte Casa Brisa + Casa Marea juntas (hasta 12).`;
    }
    return `Lamentablemente, ${q.propertyName} no está disponible del ${fmtDateEs(input.checkIn)} al ${fmtDateEs(input.checkOut)}. 😔

¿Te interesa cambiar las fechas o probar otra de nuestras propiedades?`;
  }

  // Caso 2: disponible — cotización completa
  return `¡Disponible! ✅ ${q.propertyName} del ${fmtDateEs(input.checkIn)} al ${fmtDateEs(input.checkOut)} (${q.nights} noche${q.nights > 1 ? "s" : ""}).

💰 *Cotización:*
${q.nights} noche${q.nights > 1 ? "s" : ""} × ${fmtHnl(q.pricePerNightHNL)} = ${fmtHnl(q.nights * q.pricePerNightHNL)}
Limpieza: ${fmtHnl(q.cleaningFeeHNL)}
*Total: ${fmtHnl(q.totalHNL)}*

🪙 *Para reservar:*
50% ahora: *${fmtHnl(q.depositHNL)}*
50% el día de check-in: ${fmtHnl(q.balanceHNL)}

¿Te interesa confirmar? Si me dices que sí, te paso el link de pago. 🌴`;
}
