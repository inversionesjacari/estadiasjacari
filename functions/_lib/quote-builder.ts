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
import type { Lang } from "./i18n";

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
  "las-gemelas-tela": {
    slug: "las-gemelas-tela",
    name: "Las Gemelas (Casa Brisa + Casa Marea)",
    city: "Tela",
    capacity: 12,
    pricePerNightHNL: 4900,
    cleaningFeeHNL: 700,
    pricePerNightUSD: 176,
    cleaningFeeUSD: 28,
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
  /** Si el paquete "Friends Trip" agregó un day pass, monto YA incluido en totalHNL/USD (para desglosarlo en el mensaje). */
  dayPassHNL?: number;
  dayPassIsWeekend?: boolean;
  dayPassAdults?: number;
  dayPassChildren?: number;
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
  pricingMap: Record<PropertySlug, PropertyPricing> = PROPERTY_PRICING,
): Promise<QuoteOutput | null> {
  const pricing = pricingMap[input.property] ?? PROPERTY_PRICING[input.property];
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

// ─────────────────────────────────────────────────────────────────────────────
// Paquetes de marketing (9-jul-2026, "Family pack" / "Love Trip" / "Friends Trip")
// ─────────────────────────────────────────────────────────────────────────────

/** Tasa implícita del catálogo (Villa B11/Casa Brisa/Casa Marea: 2,500 HNL ≈ 90
 *  USD/noche) — se reusa para convertir el day pass a USD con el mismo criterio. */
const LODGING_HNL_PER_USD = 2500 / 90;

export interface DayPassParty {
  adults: number;
  /** Bebés NO se pasan acá — son gratis y no cuentan (decisión de César). */
  children: number;
  checkIn: string;  // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
}

/**
 * Day pass Hotel Honduras Shores Plantation (paquete "Friends Trip", Las Gemelas
 * de Tela): adulto L.250 entre semana / L.350 fin de semana; niño L.150 cualquier
 * día. "Fin de semana" = la estadía incluye una noche de viernes, sábado o domingo.
 */
export function computeDayPassHNL(p: DayPassParty): { hnl: number; isWeekend: boolean } {
  const start = new Date(p.checkIn + "T00:00:00Z").getTime();
  const end = new Date(p.checkOut + "T00:00:00Z").getTime();
  let isWeekend = false;
  for (let t = start; t < end; t += 86_400_000) {
    const dow = new Date(t).getUTCDay(); // 0=domingo … 6=sábado
    if (dow === 5 || dow === 6 || dow === 0) { isWeekend = true; break; }
  }
  const adultRate = isWeekend ? 350 : 250;
  return { hnl: p.adults * adultRate + p.children * 150, isWeekend };
}

/** Suma el day pass a una cotización YA verificada (Total/depósito/saldo quedan
 *  inclusive) — usar SIEMPRE que `packageType === "friends_trip"`, en cada lugar
 *  donde se muestre el monto a pagar (si no, el depósito queda corto). */
export function addDayPass(quote: QuoteOutput, party: DayPassParty): QuoteOutput {
  if (!quote.available) return quote;
  const { hnl, isWeekend } = computeDayPassHNL(party);
  const totalHNL = quote.totalHNL + hnl;
  const totalUSD = quote.totalUSD + Math.round(hnl / LODGING_HNL_PER_USD);
  const depositHNL = Math.ceil(totalHNL / 2);
  const depositUSD = Math.ceil(totalUSD / 2);
  return {
    ...quote,
    totalHNL, depositHNL, balanceHNL: totalHNL - depositHNL,
    totalUSD, depositUSD, balanceUSD: totalUSD - depositUSD,
    dayPassHNL: hnl,
    dayPassIsWeekend: isWeekend,
    dayPassAdults: party.adults,
    dayPassChildren: party.children,
  };
}

/** Precio FIJO del paquete "Family pack"/"Love Trip" (Villa B11, La Ceiba): no
 *  varía sean 2 o 6 personas — solo aplica cuando la estadía es EXACTAMENTE de
 *  2 noches (la duración del paquete); para otra duración se cotiza normal. */
export const VILLA_B11_PACKAGE_TOTAL_HNL = 5400;
const VILLA_B11_PACKAGE_TOTAL_USD = Math.round(VILLA_B11_PACKAGE_TOTAL_HNL / LODGING_HNL_PER_USD);

export function applyVillaB11PackagePrice(quote: QuoteOutput): QuoteOutput {
  if (!quote.available || quote.nights !== 2) return quote;
  const totalHNL = VILLA_B11_PACKAGE_TOTAL_HNL;
  const totalUSD = VILLA_B11_PACKAGE_TOTAL_USD;
  const depositHNL = Math.ceil(totalHNL / 2);
  const depositUSD = Math.ceil(totalUSD / 2);
  return { ...quote, totalHNL, depositHNL, balanceHNL: totalHNL - depositHNL, totalUSD, depositUSD, balanceUSD: totalUSD - depositUSD };
}

/** Formato HNL con separador de miles. */
function fmtHnl(n: number): string {
  return `HNL ${n.toLocaleString("es-HN")}`;
}

/** Formato fecha abreviado por idioma: es "15 jun" · en "Jun 15" */
function fmtDate(iso: string, lang: Lang = "es"): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDate();
  if (lang === "en") {
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    return `${months[d.getUTCMonth()]} ${day}`;
  }
  const months = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  return `${day} ${months[d.getUTCMonth()]}`;
}

/**
 * Formatea el resultado de buildQuote como mensaje WhatsApp listo para enviar.
 * Tono cálido, claro, con emojis al inicio/final (sin firma personal).
 */
export function formatQuoteMessage(
  q: QuoteOutput,
  input: QuoteInput,
  lang: Lang = "es",
): string {
  const closingEmoji = q.city === "Tegucigalpa" ? "" : " 🌴";

  // Día pass (paquete "Friends Trip") — línea extra entre limpieza y total.
  const dayPassLine = q.dayPassHNL
    ? lang === "en"
      ? `Day pass Honduras Shores Plantation Hotel (${q.dayPassAdults} adult${q.dayPassAdults === 1 ? "" : "s"}${
          q.dayPassChildren ? ` + ${q.dayPassChildren} kid${q.dayPassChildren === 1 ? "" : "s"}` : ""
        }, ${q.dayPassIsWeekend ? "weekend" : "weekday"}): ${fmtHnl(q.dayPassHNL)}\n`
      : `Day pass Hotel Honduras Shores Plantation (${q.dayPassAdults} adulto${q.dayPassAdults === 1 ? "" : "s"}${
          q.dayPassChildren ? ` + ${q.dayPassChildren} niño${q.dayPassChildren === 1 ? "" : "s"}` : ""
        }, ${q.dayPassIsWeekend ? "fin de semana" : "entre semana"}): ${fmtHnl(q.dayPassHNL)}\n`
    : "";

  // ── Inglés ────────────────────────────────────────────────────────────────
  if (lang === "en") {
    if (!q.available) {
      if (q.exceedsCapacity) {
        return `Unfortunately, ${q.propertyName} holds up to ${q.capacity} guests and you're ${input.guests}. 😔

Would you like another property with more capacity? We have options for up to 6 guests, or for larger groups we can rent Casa Brisa + Casa Marea together (up to 12).`;
      }
      return `Unfortunately, ${q.propertyName} isn't available from ${fmtDate(input.checkIn, "en")} to ${fmtDate(input.checkOut, "en")}. 😔

Would you like to try other dates or another property?`;
    }
    return `Available! ✅ ${q.propertyName} from ${fmtDate(input.checkIn, "en")} to ${fmtDate(input.checkOut, "en")} (${q.nights} night${q.nights > 1 ? "s" : ""}).

💰 *Quote:*
${q.nights} night${q.nights > 1 ? "s" : ""} × ${fmtHnl(q.pricePerNightHNL)} = ${fmtHnl(q.nights * q.pricePerNightHNL)}
Cleaning: ${fmtHnl(q.cleaningFeeHNL)}
${dayPassLine}*Total: ${fmtHnl(q.totalHNL)}*

🪙 *To book:*
50% now: *${fmtHnl(q.depositHNL)}*
50% at check-in: ${fmtHnl(q.balanceHNL)}

Shall we confirm? You can pay the 50% by *bank transfer* or *card/PayPal*, whichever works best.${closingEmoji}`;
  }

  // ── Español ─────────────────────────────────────────────────────────────────
  if (!q.available) {
    if (q.exceedsCapacity) {
      return `Lamentablemente, ${q.propertyName} tiene capacidad para ${q.capacity} huéspedes y son ${input.guests}. 😔

¿Te interesa otra de nuestras propiedades con mayor capacidad? Tenemos opciones para hasta 6 huéspedes, o si son más, podemos rentarte Casa Brisa + Casa Marea juntas (hasta 12).`;
    }
    return `Lamentablemente, ${q.propertyName} no está disponible del ${fmtDate(input.checkIn)} al ${fmtDate(input.checkOut)}. 😔

¿Te interesa cambiar las fechas o probar otra de nuestras propiedades?`;
  }

  return `¡Disponible! ✅ ${q.propertyName} del ${fmtDate(input.checkIn)} al ${fmtDate(input.checkOut)} (${q.nights} noche${q.nights > 1 ? "s" : ""}).

💰 *Cotización:*
${q.nights} noche${q.nights > 1 ? "s" : ""} × ${fmtHnl(q.pricePerNightHNL)} = ${fmtHnl(q.nights * q.pricePerNightHNL)}
Limpieza: ${fmtHnl(q.cleaningFeeHNL)}
${dayPassLine}*Total: ${fmtHnl(q.totalHNL)}*

🪙 *Para reservar:*
50% ahora: *${fmtHnl(q.depositHNL)}*
50% el día de check-in: ${fmtHnl(q.balanceHNL)}

¿Confirmás la reserva? El 50% lo podés pagar por *transferencia bancaria* o *tarjeta/PayPal*, lo que te quede más cómodo.${closingEmoji}`;
}
