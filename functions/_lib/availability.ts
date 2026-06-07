/// <reference types="@cloudflare/workers-types" />
//
// availability.ts — Verificación de disponibilidad (Airbnb iCal + D1).
//
// Fuente de verdad COMPARTIDA entre:
//   - GET /api/availability/[slug] (el calendar del sitio)
//   - el bot de WhatsApp (quote flow) — para NO cotizar fechas ocupadas
//
// Antes esta lógica vivía solo en el endpoint; el bot no la usaba y por eso
// cotizaba fechas ya reservadas en Airbnb (riesgo de doble reserva). Ahora
// ambos consumen este helper.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

// @ts-ignore — ical.js no publica tipos oficiales
import ICAL from "ical.js";
import { fetchWithTimeout, TIMEOUT } from "./fetch";

export type IcalEnvKey =
  | "AIRBNB_ICAL_VILLA_B11_PALMA_REAL"
  | "AIRBNB_ICAL_CASA_BRISA"
  | "AIRBNB_ICAL_CASA_MAREA"
  | "AIRBNB_ICAL_LAS_GEMELAS_DE_TELA"
  | "AIRBNB_ICAL_CENTRO_MORAZAN"
  | "AIRBNB_ICAL_CASA_LARA_TOWNHOUSE"
  | "AIRBNB_ICAL_LA_FLORIDA";

export type IcalEnv = { [K in IcalEnvKey]?: string };

export interface AvailabilityEnv extends IcalEnv {
  DB?: D1Database;
}

type SourceConfig = {
  envVarName: IcalEnvKey;
  onlyReserved?: boolean;
};

/** slug → fuentes iCal. Ver doc completa en el endpoint [slug].ts. */
export const SLUG_TO_SOURCES: Record<string, SourceConfig[]> = {
  "villa-b11-palma-real": [{ envVarName: "AIRBNB_ICAL_VILLA_B11_PALMA_REAL" }],
  "casa-brisa": [
    { envVarName: "AIRBNB_ICAL_CASA_BRISA" },
    { envVarName: "AIRBNB_ICAL_LAS_GEMELAS_DE_TELA", onlyReserved: true },
  ],
  "casa-marea": [
    { envVarName: "AIRBNB_ICAL_CASA_MAREA" },
    { envVarName: "AIRBNB_ICAL_LAS_GEMELAS_DE_TELA", onlyReserved: true },
  ],
  "centro-morazan": [{ envVarName: "AIRBNB_ICAL_CENTRO_MORAZAN" }],
  "casa-lara-townhouse": [{ envVarName: "AIRBNB_ICAL_CASA_LARA_TOWNHOUSE" }],
  "la-florida": [{ envVarName: "AIRBNB_ICAL_LA_FLORIDA" }],
};

export interface BlockedDatesResult {
  blocked: Set<string>;
  perSource: { source: string; blockedCount: number; onlyReserved?: boolean }[];
  warnings: string[];
  airbnbSyncStatus: "full" | "partial" | "unavailable";
}

/**
 * Obtiene todas las fechas bloqueadas para un slug (Airbnb iCal + D1).
 * Fail-open: si una fuente falla, se registra en warnings pero no se lanza error.
 */
export async function getBlockedDates(
  slug: string,
  env: AvailabilityEnv,
): Promise<BlockedDatesResult | null> {
  const sourceConfigs = SLUG_TO_SOURCES[slug];
  if (!sourceConfigs) return null;

  const sources: { envVarName: IcalEnvKey; url: string; onlyReserved: boolean }[] = [];
  const warnings: string[] = [];
  for (const config of sourceConfigs) {
    const url = env[config.envVarName];
    if (url) {
      sources.push({
        envVarName: config.envVarName,
        url,
        onlyReserved: config.onlyReserved ?? false,
      });
    } else {
      warnings.push(`Falta env var ${config.envVarName}`);
    }
  }

  const fetchResults = await Promise.all(
    sources.map(async ({ envVarName, url, onlyReserved }) => {
      try {
        const resp = await fetchWithTimeout(
          url,
          {
            headers: {
              "User-Agent": "EstadiasJacari/1.0 (+https://estadiasjacari.com)",
              Accept: "text/calendar, text/plain;q=0.5",
            },
            cf: { cacheTtl: 900, cacheEverything: true },
          },
          TIMEOUT.STANDARD,
        );
        if (!resp.ok) {
          return { envVarName, onlyReserved, ok: false as const, error: `HTTP ${resp.status}` };
        }
        return { envVarName, onlyReserved, ok: true as const, text: await resp.text() };
      } catch (err) {
        return { envVarName, onlyReserved, ok: false as const, error: (err as Error).message };
      }
    }),
  );

  for (const r of fetchResults) {
    if (!r.ok) warnings.push(`Fuente ${r.envVarName} falló: ${r.error}`);
  }

  const blocked = new Set<string>();
  const perSource: BlockedDatesResult["perSource"] = [];
  for (const result of fetchResults) {
    if (!result.ok) continue;
    try {
      const dates = parseICalToBlockedDates(result.text, result.onlyReserved);
      dates.forEach((d) => blocked.add(d));
      perSource.push({
        source: result.envVarName,
        blockedCount: dates.length,
        onlyReserved: result.onlyReserved,
      });
    } catch (err) {
      warnings.push(`Fuente ${result.envVarName} parse error: ${(err as Error).message}`);
    }
  }

  // D1: reservas pending/confirmed del propio sitio
  if (env.DB) {
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const { results } = await env.DB.prepare(
        `SELECT check_in, check_out
           FROM reservations
          WHERE property_slug = ?
            AND status IN ('pending', 'confirmed')
            AND check_out >= ?`,
      )
        .bind(slug, todayIso)
        .all<{ check_in: string; check_out: string }>();

      let d1Count = 0;
      for (const row of results ?? []) {
        const cursor = new Date(row.check_in + "T00:00:00Z");
        const end = new Date(row.check_out + "T00:00:00Z");
        while (cursor < end) {
          blocked.add(cursor.toISOString().slice(0, 10));
          cursor.setUTCDate(cursor.getUTCDate() + 1);
          d1Count++;
        }
      }
      perSource.push({ source: "D1_RESERVATIONS", blockedCount: d1Count });
    } catch (err) {
      console.error(`[availability/${slug}] D1 error:`, (err as Error).message);
      perSource.push({ source: "D1_RESERVATIONS", blockedCount: -1 });
    }
  }

  const totalAirbnbSources = sourceConfigs.length;
  const okAirbnbSources = perSource.filter((s) => s.source !== "D1_RESERVATIONS").length;
  let airbnbSyncStatus: "full" | "partial" | "unavailable";
  if (okAirbnbSources === totalAirbnbSources) airbnbSyncStatus = "full";
  else if (okAirbnbSources > 0) airbnbSyncStatus = "partial";
  else airbnbSyncStatus = "unavailable";

  return { blocked, perSource, warnings, airbnbSyncStatus };
}

export interface RangeAvailability {
  /** true si TODO el rango [checkIn, checkOut) está libre. */
  available: boolean;
  /**
   * true si pudimos consultar Airbnb (sync full/partial). Si es false, NO
   * confiar en `available` para auto-confirmar reservas — escalar a humano.
   */
  verified: boolean;
  /** Fechas en conflicto (ocupadas) dentro del rango pedido. */
  conflictDates: string[];
}

/**
 * Verifica si un rango de fechas está disponible para un slug.
 * checkIn inclusivo, checkOut exclusivo (la noche del check-out queda libre).
 */
export async function checkRangeAvailable(
  slug: string,
  checkInIso: string,
  checkOutIso: string,
  env: AvailabilityEnv,
): Promise<RangeAvailability> {
  const result = await getBlockedDates(slug, env);
  if (!result) {
    // slug desconocido — no podemos verificar
    return { available: false, verified: false, conflictDates: [] };
  }

  const verified = result.airbnbSyncStatus !== "unavailable";

  // Expandir el rango pedido en noches individuales y ver si alguna está bloqueada
  const conflictDates: string[] = [];
  const cursor = new Date(checkInIso + "T00:00:00Z");
  const end = new Date(checkOutIso + "T00:00:00Z");
  while (cursor < end) {
    const iso = cursor.toISOString().slice(0, 10);
    if (result.blocked.has(iso)) conflictDates.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    available: conflictDates.length === 0,
    verified,
    conflictDates,
  };
}

/**
 * Convierte iCal a fechas bloqueadas. DTSTART inclusivo, DTEND exclusivo.
 * onlyReserved: solo cuenta VEVENTs con SUMMARY="Reserved" (iCals cruzados).
 */
export function parseICalToBlockedDates(icalText: string, onlyReserved = false): string[] {
  const jcalData = ICAL.parse(icalText);
  const vcalendar = new ICAL.Component(jcalData);
  const vevents = vcalendar.getAllSubcomponents("vevent");

  const dates = new Set<string>();
  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);
    if (onlyReserved) {
      const summary = (event.summary ?? "").trim();
      if (!/^reserved$/i.test(summary)) continue;
    }
    const start: Date = event.startDate.toJSDate();
    const end: Date = event.endDate.toJSDate();
    const cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
    );
    const stop = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
    );
    while (cursor < stop) {
      dates.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return Array.from(dates);
}
