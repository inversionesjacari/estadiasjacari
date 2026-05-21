/// <reference types="@cloudflare/workers-types" />
//
// GET /api/availability/[slug]
//
// Lee el calendario iCal de Airbnb (URL en env var secreta) y devuelve las
// fechas bloqueadas como JSON. Pensado para que el BookingWidget del sitio
// pueda tachar fechas no disponibles antes de cobrar.
//
// Configuración previa requerida (en Cloudflare Pages → Settings → Environment
// variables): una variable de entorno encriptada por propiedad, con la URL
// iCal exportable de Airbnb. Mapeo slug → env var: ver SLUG_TO_ENV abajo.
//
// Respuesta de éxito (200):
//   {
//     "slug": "villa-b11-palma-real",
//     "blockedDates": ["2026-06-15", "2026-06-16", ...],
//     "lastSync": "2026-05-21T12:34:56.789Z",
//     "source": "airbnb"
//   }
//
// Errores:
//   404 — slug desconocido
//   500 — env var faltante
//   502 — Airbnb no respondió o respondió con error / iCal inválido
//

// @ts-ignore — ical.js no publica tipos oficiales
import ICAL from "ical.js";

/** Nombres de env vars que contienen URLs iCal de Airbnb (strings). */
type IcalEnvKey =
  | "AIRBNB_ICAL_VILLA_B11_PALMA_REAL"
  | "AIRBNB_ICAL_CASA_BRISA"
  | "AIRBNB_ICAL_CASA_MAREA"
  | "AIRBNB_ICAL_LAS_GEMELAS_DE_TELA"
  | "AIRBNB_ICAL_CENTRO_MORAZAN"
  | "AIRBNB_ICAL_CASA_LARA_TOWNHOUSE"
  | "AIRBNB_ICAL_LA_FLORIDA";

type IcalEnv = { [K in IcalEnvKey]?: string };

interface Env extends IcalEnv {
  // Binding D1 (opcional — si no está configurado, el endpoint sigue funcionando
  // con solo Airbnb, lo cual es el comportamiento de Fase 1/2).
  DB?: D1Database;
}

/**
 * Configuración de cada fuente iCal para un slug.
 *  - envVarName: nombre de la variable de entorno con la URL del iCal.
 *  - onlyReserved: si true, solo cuenta VEVENTs con SUMMARY = "Reserved"
 *    (reservas reales del propio listing). Se usa para iCals cruzados
 *    como Las Gemelas de Tela, donde Airbnb sincroniza automáticamente
 *    las reservas de Casa Brisa y Casa Marea con SUMMARY "Airbnb (Not
 *    available)" — esos bloqueos NO deben propagarse de vuelta a las
 *    casas individuales, solo las reservas reales del listing Gemelas.
 */
type SourceConfig = {
  envVarName: IcalEnvKey;
  onlyReserved?: boolean;
};

/**
 * Mapeo de slug de propiedad → lista de fuentes iCal.
 *
 * Caso especial — Las Gemelas de Tela:
 *   Es un 3er listing en Airbnb que renta Casa Brisa + Casa Marea juntas
 *   para grupos de hasta 12 personas. Comportamiento de Airbnb:
 *   - Reserva real en Casa Marea → "Reserved" en Marea, "Airbnb (Not available)"
 *     en Las Gemelas (sync auto)
 *   - Reserva real en Casa Brisa → "Reserved" en Brisa
 *   - Reserva real en Las Gemelas → "Reserved" en Las Gemelas
 *
 *   Por lo tanto:
 *   - Casa Brisa lee: su propio iCal completo + Gemelas filtrado a solo "Reserved"
 *     (evita que las "Not available" derivadas de Marea bloqueen Brisa por error).
 *   - Casa Marea lee: su propio iCal completo + Gemelas filtrado a solo "Reserved".
 *
 * Los slugs canónicos viven en src/data/properties.ts — si cambia alguno,
 * actualizar este mapping en sincronía.
 */
const SLUG_TO_SOURCES: Record<string, SourceConfig[]> = {
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

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env } = context;
  const slug = String(params.slug ?? "");

  // 1. Validar slug conocido
  const sourceConfigs = SLUG_TO_SOURCES[slug];
  if (!sourceConfigs) {
    return json(
      {
        error: "unknown_slug",
        message: `Slug "${slug}" no está registrado.`,
        knownSlugs: Object.keys(SLUG_TO_SOURCES),
      },
      404
    );
  }

  // 2. Resolver URLs desde env vars — todas las del slug deben estar presentes
  const sources: {
    envVarName: IcalEnvKey;
    url: string;
    onlyReserved: boolean;
  }[] = [];
  const missing: string[] = [];
  for (const config of sourceConfigs) {
    const url = env[config.envVarName];
    if (url) {
      sources.push({
        envVarName: config.envVarName,
        url,
        onlyReserved: config.onlyReserved ?? false,
      });
    } else {
      missing.push(config.envVarName);
    }
  }
  if (missing.length > 0) {
    return json(
      {
        error: "missing_env_var",
        message:
          `Faltan variables de entorno: ${missing.join(", ")}. ` +
          `Configúralas en Cloudflare Pages → Settings → Environment variables ` +
          `con las URLs iCal exportables de Airbnb ` +
          `(Calendar → Sync calendars → Export calendar).`,
        slug,
        missing,
      },
      500
    );
  }

  // 3. Fetch en paralelo de todas las URLs configuradas para este slug
  const fetchResults = await Promise.all(
    sources.map(async ({ envVarName, url, onlyReserved }) => {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "EstadiasJacari/1.0 (+https://estadiasjacari.com)",
            Accept: "text/calendar, text/plain;q=0.5",
          },
          // Edge cache: 15 min — Cloudflare reusará la respuesta sin re-pegarle
          // a Airbnb. Esto reemplaza temporalmente al KV cache de Fase 2.
          cf: { cacheTtl: 900, cacheEverything: true },
        });
        if (!resp.ok) {
          return {
            envVarName,
            onlyReserved,
            ok: false as const,
            error: `Airbnb devolvió HTTP ${resp.status}. La URL puede estar caducada — regenérala en Airbnb y actualiza la env var.`,
          };
        }
        return {
          envVarName,
          onlyReserved,
          ok: true as const,
          text: await resp.text(),
        };
      } catch (err) {
        return {
          envVarName,
          onlyReserved,
          ok: false as const,
          error: `Error de red: ${(err as Error).message}`,
        };
      }
    })
  );

  // Si alguna fuente falló al fetch, devolver 502 con detalle por fuente
  const failedFetches = fetchResults.filter((r) => !r.ok);
  if (failedFetches.length > 0) {
    return json(
      {
        error: "airbnb_fetch_failed",
        message:
          "Una o más URLs iCal de Airbnb fallaron al consultar. " +
          "No se devuelven fechas parciales para evitar mostrar disponibilidad incorrecta.",
        slug,
        failures: failedFetches.map((f) => ({
          source: f.envVarName,
          error: f.ok ? undefined : f.error,
        })),
      },
      502
    );
  }

  // 4. Parsear cada iCal y unir las fechas bloqueadas (set para dedup)
  const allDates = new Set<string>();
  const perSource: {
    source: string;
    blockedCount: number;
    onlyReserved?: boolean;
  }[] = [];
  try {
    for (const result of fetchResults) {
      if (!result.ok) continue; // imposible aquí (ya verificamos), pero TS lo necesita
      const dates = parseICalToBlockedDates(result.text, result.onlyReserved);
      dates.forEach((d) => allDates.add(d));
      perSource.push({
        source: result.envVarName,
        blockedCount: dates.length,
        onlyReserved: result.onlyReserved,
      });
    }
  } catch (err) {
    return json(
      {
        error: "ical_parse_error",
        message:
          `No se pudo parsear la respuesta de Airbnb como iCal: ` +
          `${(err as Error).message}`,
        slug,
      },
      502
    );
  }

  // 4b. Agregar fechas de reservas pagadas en el sitio (D1, status pending/confirmed)
  //     Si el binding DB no está configurado o falla, ignoramos silenciosamente
  //     — el endpoint sigue respondiendo solo con datos de Airbnb (Fase 1/2).
  if (env.DB) {
    try {
      // Solo reservas futuras o actuales (check_out >= hoy en UTC)
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
        // Expandir cada reserva en fechas individuales (DTEND exclusivo, igual que iCal)
        const start = new Date(row.check_in + "T00:00:00Z");
        const end = new Date(row.check_out + "T00:00:00Z");
        const cursor = new Date(start);
        while (cursor < end) {
          allDates.add(cursor.toISOString().slice(0, 10));
          cursor.setUTCDate(cursor.getUTCDate() + 1);
          d1Count++;
        }
      }
      perSource.push({
        source: "D1_RESERVATIONS",
        blockedCount: d1Count,
      });
    } catch (err) {
      // No fallar el endpoint si D1 tiene problemas — log para debug.
      console.error(
        `[availability/${slug}] Error consultando D1:`,
        (err as Error).message,
      );
      perSource.push({
        source: "D1_RESERVATIONS",
        blockedCount: -1,
      });
    }
  }

  // 5. Respuesta exitosa con Cache-Control para el navegador y CDN
  return json(
    {
      slug,
      blockedDates: Array.from(allDates).sort(),
      sources: perSource,
      lastSync: new Date().toISOString(),
      source: "airbnb+d1",
    },
    200,
    {
      // Navegador: 5 min · CDN: 15 min (alineado con el cf.cacheTtl de arriba)
      "Cache-Control": "public, max-age=300, s-maxage=900",
    }
  );
};

/**
 * Convierte un iCal de Airbnb en una lista de fechas individuales bloqueadas.
 * Convención iCal: DTSTART inclusivo, DTEND exclusivo (el día de check-out
 * sigue disponible para que otro huésped haga check-in).
 *
 * Si `onlyReserved=true`, solo cuenta VEVENTs con SUMMARY = "Reserved"
 * (reservas reales del propio listing). Útil para iCals cruzados donde
 * Airbnb sincroniza automáticamente bloqueos derivados de otros listings
 * (esos llegan con SUMMARY "Airbnb (Not available)" y NO deben propagarse
 * de vuelta a las casas individuales — ya están en sus iCals propios).
 */
function parseICalToBlockedDates(
  icalText: string,
  onlyReserved = false,
): string[] {
  const jcalData = ICAL.parse(icalText);
  const vcalendar = new ICAL.Component(jcalData);
  const vevents = vcalendar.getAllSubcomponents("vevent");

  const dates = new Set<string>();
  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);

    if (onlyReserved) {
      const summary = (event.summary ?? "").trim();
      // "Reserved" = reserva real en el propio listing
      // "Airbnb (Not available)" / "Not available" / "Blocked" = sync auto o
      // bloqueo manual del owner — ignorar cuando es iCal cruzado
      if (!/^reserved$/i.test(summary)) {
        continue;
      }
    }

    const start: Date = event.startDate.toJSDate();
    const end: Date = event.endDate.toJSDate();

    // Iterar día por día desde DTSTART (inclusive) hasta DTEND (exclusive)
    const cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
    );
    const stop = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
    );
    while (cursor < stop) {
      dates.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  // Sin sort — el caller hace dedup + sort al unir varias fuentes
  return Array.from(dates);
}

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
