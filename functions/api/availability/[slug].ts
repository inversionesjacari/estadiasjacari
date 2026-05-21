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
  AIRBNB_ICAL_CENTRO_MORAZAN?: string;
  AIRBNB_ICAL_CASA_LARA_TOWNHOUSE?: string;
  AIRBNB_ICAL_LA_FLORIDA?: string;
}

/**
 * Mapeo de slug de propiedad a nombre de variable de entorno.
 * Los slugs canónicos viven en src/data/properties.ts — si cambia alguno,
 * actualizar este mapping en sincronía.
 */
const SLUG_TO_ENV: Record<string, keyof Env> = {
  "villa-b11-palma-real": "AIRBNB_ICAL_VILLA_B11_PALMA_REAL",
  "casa-brisa": "AIRBNB_ICAL_CASA_BRISA",
  "casa-marea": "AIRBNB_ICAL_CASA_MAREA",
  "centro-morazan": "AIRBNB_ICAL_CENTRO_MORAZAN",
  "casa-lara-townhouse": "AIRBNB_ICAL_CASA_LARA_TOWNHOUSE",
  "la-florida": "AIRBNB_ICAL_LA_FLORIDA",
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env } = context;
  const slug = String(params.slug ?? "");

  // 1. Validar slug conocido
  const envVarName = SLUG_TO_ENV[slug];
  if (!envVarName) {
    return json(
      {
        error: "unknown_slug",
        message: `Slug "${slug}" no está registrado.`,
        knownSlugs: Object.keys(SLUG_TO_ENV),
      },
      404
    );
  }

  // 2. Validar env var configurada en Cloudflare
  const icalUrl = env[envVarName];
  if (!icalUrl) {
    return json(
      {
        error: "missing_env_var",
        message:
          `Falta configurar la variable de entorno ${envVarName} en ` +
          `Cloudflare Pages → Settings → Environment variables. ` +
          `Su valor debe ser la URL iCal exportable de la propiedad en Airbnb ` +
          `(Calendar → Sync calendars → Export calendar).`,
        slug,
      },
      500
    );
  }

  // 3. Fetch del iCal desde Airbnb
  let icalText: string;
  try {
    const resp = await fetch(icalUrl, {
      headers: {
        "User-Agent": "EstadiasJacari/1.0 (+https://estadiasjacari.com)",
        Accept: "text/calendar, text/plain;q=0.5",
      },
      // Edge cache: 15 min — Cloudflare reusará la respuesta sin re-pegarle
      // a Airbnb. Esto reemplaza temporalmente al KV cache de Fase 2.
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!resp.ok) {
      return json(
        {
          error: "airbnb_fetch_failed",
          status: resp.status,
          message:
            `Airbnb devolvió HTTP ${resp.status} al pedir el iCal. ` +
            `La URL puede estar caducada o ser inválida — regenérala en Airbnb ` +
            `(Calendar → Sync calendars → Export calendar) y actualiza la env var.`,
          slug,
        },
        502
      );
    }
    icalText = await resp.text();
  } catch (err) {
    return json(
      {
        error: "airbnb_fetch_error",
        message: `Error de red al consultar Airbnb: ${(err as Error).message}`,
        slug,
      },
      502
    );
  }

  // 4. Parsear iCal y extraer fechas bloqueadas
  let blockedDates: string[];
  try {
    blockedDates = parseICalToBlockedDates(icalText);
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
      blockedDates,
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

  return Array.from(dates).sort();
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
