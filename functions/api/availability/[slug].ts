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

interface Env {
  AIRBNB_ICAL_VILLA_B11_PALMA_REAL?: string;
  AIRBNB_ICAL_CASA_BRISA?: string;
  AIRBNB_ICAL_CASA_MAREA?: string;
  AIRBNB_ICAL_LAS_GEMELAS_DE_TELA?: string;
  AIRBNB_ICAL_CENTRO_MORAZAN?: string;
  AIRBNB_ICAL_CASA_LARA_TOWNHOUSE?: string;
  AIRBNB_ICAL_LA_FLORIDA?: string;
}

/**
 * Mapeo de slug de propiedad a una o más variables de entorno con URLs iCal
 * de Airbnb. Cuando un slug mapea a varias URLs, las fechas bloqueadas son la
 * unión de todas (cualquier reserva en cualquiera de los listings bloquea).
 *
 * Caso especial — Las Gemelas de Tela:
 *   "Las Gemelas" es un 3er listing en Airbnb que renta Casa Brisa + Casa
 *   Marea juntas (para grupos de hasta 12). Cuando ese listing se reserva,
 *   AMBAS casas físicas están ocupadas — por eso `casa-brisa` y `casa-marea`
 *   en el sitio incluyen `AIRBNB_ICAL_LAS_GEMELAS_DE_TELA` en su lista.
 *
 * Los slugs canónicos viven en src/data/properties.ts — si cambia alguno,
 * actualizar este mapping en sincronía.
 */
const SLUG_TO_ENVS: Record<string, (keyof Env)[]> = {
  "villa-b11-palma-real": ["AIRBNB_ICAL_VILLA_B11_PALMA_REAL"],
  "casa-brisa": ["AIRBNB_ICAL_CASA_BRISA", "AIRBNB_ICAL_LAS_GEMELAS_DE_TELA"],
  "casa-marea": ["AIRBNB_ICAL_CASA_MAREA", "AIRBNB_ICAL_LAS_GEMELAS_DE_TELA"],
  "centro-morazan": ["AIRBNB_ICAL_CENTRO_MORAZAN"],
  "casa-lara-townhouse": ["AIRBNB_ICAL_CASA_LARA_TOWNHOUSE"],
  "la-florida": ["AIRBNB_ICAL_LA_FLORIDA"],
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env } = context;
  const slug = String(params.slug ?? "");

  // 1. Validar slug conocido
  const envVarNames = SLUG_TO_ENVS[slug];
  if (!envVarNames) {
    return json(
      {
        error: "unknown_slug",
        message: `Slug "${slug}" no está registrado.`,
        knownSlugs: Object.keys(SLUG_TO_ENVS),
      },
      404
    );
  }

  // 2. Resolver URLs desde env vars — todas las del slug deben estar presentes
  const sources: { envVarName: keyof Env; url: string }[] = [];
  const missing: string[] = [];
  for (const envVarName of envVarNames) {
    const url = env[envVarName];
    if (url) {
      sources.push({ envVarName, url });
    } else {
      missing.push(envVarName);
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
    sources.map(async ({ envVarName, url }) => {
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
            ok: false as const,
            error: `Airbnb devolvió HTTP ${resp.status}. La URL puede estar caducada — regenérala en Airbnb y actualiza la env var.`,
          };
        }
        return { envVarName, ok: true as const, text: await resp.text() };
      } catch (err) {
        return {
          envVarName,
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
  const perSource: { source: keyof Env; blockedCount: number }[] = [];
  try {
    for (const result of fetchResults) {
      if (!result.ok) continue; // imposible aquí (ya verificamos), pero TS lo necesita
      const dates = parseICalToBlockedDates(result.text);
      dates.forEach((d) => allDates.add(d));
      perSource.push({ source: result.envVarName, blockedCount: dates.length });
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

  // 5. Respuesta exitosa con Cache-Control para el navegador y CDN
  return json(
    {
      slug,
      blockedDates: Array.from(allDates).sort(),
      sources: perSource,
      lastSync: new Date().toISOString(),
      source: "airbnb",
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
 */
function parseICalToBlockedDates(icalText: string): string[] {
  const jcalData = ICAL.parse(icalText);
  const vcalendar = new ICAL.Component(jcalData);
  const vevents = vcalendar.getAllSubcomponents("vevent");

  const dates = new Set<string>();
  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);
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
