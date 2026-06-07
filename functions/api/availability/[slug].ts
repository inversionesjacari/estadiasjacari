/// <reference types="@cloudflare/workers-types" />
//
// GET /api/availability/[slug]
//
// Lee el calendario iCal de Airbnb + reservas D1 y devuelve las fechas
// bloqueadas como JSON, para que el BookingWidget del sitio tache fechas no
// disponibles antes de cobrar.
//
// La lógica de fetch + parse + merge vive en _lib/availability.ts (compartida
// con el bot de WhatsApp, que la usa para no cotizar fechas ya ocupadas).
//
// Política fail-open: si Airbnb falla, devuelve 200 con `warnings[]` y
// `airbnbSyncStatus` != "full" en vez de 500, para que el sitio siga funcional.
//

import {
  getBlockedDates,
  SLUG_TO_SOURCES,
  type AvailabilityEnv,
} from "../../_lib/availability";

export const onRequestGet: PagesFunction<AvailabilityEnv> = async (context) => {
  const { params, env } = context;
  const slug = String(params.slug ?? "");

  // Slug desconocido → 404 (problema de código, no de configuración)
  if (!SLUG_TO_SOURCES[slug]) {
    return json(
      {
        error: "unknown_slug",
        message: `Slug "${slug}" no está registrado.`,
        knownSlugs: Object.keys(SLUG_TO_SOURCES),
      },
      404,
    );
  }

  const result = await getBlockedDates(slug, env);
  if (!result) {
    return json({ error: "unknown_slug", message: `Slug "${slug}" no encontrado.` }, 404);
  }

  // Cache CDN reducido si la sincronización está degradada (recupera más rápido)
  const cacheControl =
    result.airbnbSyncStatus === "full"
      ? "public, max-age=300, s-maxage=900"
      : "public, max-age=60, s-maxage=60";

  return json(
    {
      slug,
      blockedDates: Array.from(result.blocked).sort(),
      sources: result.perSource,
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
      airbnbSyncStatus: result.airbnbSyncStatus,
      lastSync: new Date().toISOString(),
      source: "airbnb+d1",
    },
    200,
    { "Cache-Control": cacheControl },
  );
};

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
