//
// seasonal-pricing.ts — Tarifas de TEMPORADA por rango de noches + estadía mínima.
//
// Fuente ÚNICA de la Semana Morazánica (y futuras temporadas) para el bot Y la
// web: el bot la consume vía buildQuote (quote-builder.ts) y el sitio vía el
// BookingWidget. Módulo 100% PURO: sin D1, sin env, sin imports de runtime
// (el import de PropertySlug es type-only y se borra al compilar) — por eso el
// bundler de Next puede importarlo desde src/ sin arrastrar nada de functions.
//
// Modelo (decidido por César, 2026-07-25):
//   - Una ventana = rango de NOCHES [startNight, endNight] inclusive. La noche
//     "2026-10-10" se duerme del 10 al 11 → un check-out del 11-oct todavía
//     incluye la última noche de la ventana.
//   - Precio MIXTO noche a noche: cada noche se cobra según su fecha (las de la
//     ventana a tarifa especial, las demás a tarifa base).
//   - El MÍNIMO de noches aplica a CUALQUIER estadía que incluya al menos una
//     noche de la ventana (evita que estadías cortas fragmenten el feriado).
//   - Propiedades sin entrada en `rates` no cambian (Casa Lara, La Florida).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import type { PropertySlug } from "./quote-extractor";

export interface SeasonalRate {
  /** Tarifa por noche en HNL dentro de la ventana. */
  priceHNL: number;
  /** Estadía mínima (noches) para estadías que tocan la ventana. */
  minNights: number;
}

export interface SeasonalWindow {
  name: string;
  /** Primera noche con tarifa especial (YYYY-MM-DD, inclusive). */
  startNight: string;
  /** Última noche con tarifa especial (YYYY-MM-DD, inclusive). */
  endNight: string;
  rates: Partial<Record<PropertySlug, SeasonalRate>>;
}

// Semana Morazánica 2026 (feriado nacional HN): noches del vie 2-oct al sáb
// 10-oct (check-out hasta el dom 11). Tarifas y mínimos confirmados por César
// el 2026-07-25 — "Casita del Mar" = casa-brisa, "Paraíso Playero" = casa-marea;
// las gemelas juntas = la suma de las dos casas (3,900 × 2), mismo mínimo.
export const SEASONAL_WINDOWS: SeasonalWindow[] = [
  {
    name: "Semana Morazánica",
    startNight: "2026-10-02",
    endNight: "2026-10-10",
    rates: {
      "centro-morazan":       { priceHNL: 3000, minNights: 3 },
      "casa-brisa":           { priceHNL: 3900, minNights: 4 },
      "casa-marea":           { priceHNL: 3900, minNights: 4 },
      "villa-b11-palma-real": { priceHNL: 3900, minNights: 4 },
      "las-gemelas-tela":     { priceHNL: 7800, minNights: 4 },
    },
  },
];

/** Cota de sanidad para no iterar fechas basura (la web limita a 6 meses; el
 *  bot valida fechas aparte). Estadías más largas devuelven [] → tarifa base. */
const MAX_STAY_NIGHTS = 400;

/** Noches ISO de una estadía: [checkIn, checkOut) — la noche del check-out no se duerme. */
export function stayNights(checkInIso: string, checkOutIso: string): string[] {
  const start = new Date(checkInIso + "T00:00:00Z").getTime();
  const end = new Date(checkOutIso + "T00:00:00Z").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const nights: string[] = [];
  for (let t = start; t < end && nights.length < MAX_STAY_NIGHTS; t += 86_400_000) {
    nights.push(new Date(t).toISOString().slice(0, 10));
  }
  return nights;
}

export interface SeasonalStay {
  /** Suma HNL de TODAS las noches (base + temporada), SIN limpieza. */
  nightsTotalHNL: number;
  /** Noches a tarifa base. */
  baseNights: number;
  /** Noches a tarifa de temporada. */
  seasonNights: number;
  /** Tarifa de temporada aplicada (null si ninguna noche cayó en ventana). */
  seasonRateHNL: number | null;
  /** Nombre de la temporada tocada (null si ninguna). */
  seasonName: string | null;
}

/** Devuelve la tarifa de temporada de UNA noche para un slug, si aplica. */
function rateForNight(slug: string, nightIso: string): { rate: SeasonalRate; window: SeasonalWindow } | null {
  for (const w of SEASONAL_WINDOWS) {
    if (nightIso >= w.startNight && nightIso <= w.endNight) {
      const rate = w.rates[slug as PropertySlug];
      if (rate) return { rate, window: w };
    }
  }
  return null;
}

/**
 * Total de alojamiento noche a noche (sin limpieza), mezclando tarifa base y
 * de temporada según la fecha de cada noche.
 */
export function computeStayHNL(
  slug: string,
  checkInIso: string,
  checkOutIso: string,
  basePriceHNL: number,
): SeasonalStay {
  let nightsTotalHNL = 0;
  let baseNights = 0;
  let seasonNights = 0;
  let seasonRateHNL: number | null = null;
  let seasonName: string | null = null;
  for (const night of stayNights(checkInIso, checkOutIso)) {
    const hit = rateForNight(slug, night);
    if (hit) {
      nightsTotalHNL += hit.rate.priceHNL;
      seasonNights++;
      seasonRateHNL = hit.rate.priceHNL;
      seasonName = hit.window.name;
    } else {
      nightsTotalHNL += basePriceHNL;
      baseNights++;
    }
  }
  return { nightsTotalHNL, baseNights, seasonNights, seasonRateHNL, seasonName };
}

/**
 * Mínimo de noches exigido si la estadía toca una ventana de temporada para ese
 * slug. `null` = sin restricción (no toca ventana, o el slug no tiene tarifa).
 */
export function requiredMinNights(
  slug: string,
  checkInIso: string,
  checkOutIso: string,
): { minNights: number; seasonName: string } | null {
  for (const night of stayNights(checkInIso, checkOutIso)) {
    const hit = rateForNight(slug, night);
    if (hit) return { minNights: hit.rate.minNights, seasonName: hit.window.name };
  }
  return null;
}

/** ¿Alguna noche de la estadía cae en ventana de temporada para este slug? */
export function staysTouchesSeason(slug: string, checkInIso: string, checkOutIso: string): boolean {
  return requiredMinNights(slug, checkInIso, checkOutIso) !== null;
}
