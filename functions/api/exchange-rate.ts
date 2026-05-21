/// <reference types="@cloudflare/workers-types" />
//
// GET /api/exchange-rate
//
// Devuelve el tipo de cambio USD → HNL del día desde
// fawazahmed0/currency-api (CDN gratuito, sin auth, actualizado diariamente).
// Cachea 12 horas en edge para reducir requests.
//
// Lo usa el BookingWidget para convertir el precio en Lempiras a USD al
// momento de cobrar via PayPal — así el monto cobrado refleja el TC
// vigente y no un valor hardcoded que puede quedar desfasado.
//
// Respuesta éxito (200):
//   {
//     "rate": 26.60096077,
//     "base": "USD",
//     "quote": "HNL",
//     "date": "2026-05-21",
//     "source": "fawazahmed0/currency-api",
//     "lastSync": "2026-05-21T..."
//   }
//
// Errores:
//   502 — ambas fuentes (primary y fallback) fallaron
//

// URLs primary y fallback de la misma API (jsdelivr CDN + Cloudflare Pages mirror).
const PRIMARY_URL =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json";
const FALLBACK_URL =
  "https://currency-api.pages.dev/v1/currencies/usd.json";

interface CurrencyApiResponse {
  date?: string;
  usd?: { hnl?: number };
}

export const onRequestGet: PagesFunction = async () => {
  const attempts: { url: string; error: string }[] = [];

  for (const url of [PRIMARY_URL, FALLBACK_URL]) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "EstadiasJacari/1.0 (+https://estadiasjacari.com)",
        },
        // Edge cache 12h — el TC se actualiza diariamente, no necesitamos más fresh.
        cf: { cacheTtl: 43200, cacheEverything: true },
      });
      if (!resp.ok) {
        attempts.push({ url, error: `HTTP ${resp.status}` });
        continue;
      }
      const data = (await resp.json()) as CurrencyApiResponse;
      const rate = data?.usd?.hnl;
      if (typeof rate !== "number" || rate <= 0) {
        attempts.push({
          url,
          error: `Respuesta inválida — usd.hnl ausente o no numérico`,
        });
        continue;
      }
      return json(
        {
          rate,
          base: "USD",
          quote: "HNL",
          date: data.date ?? null,
          source: "fawazahmed0/currency-api",
          lastSync: new Date().toISOString(),
        },
        200,
        {
          // Navegador: 6h · CDN: 12h
          "Cache-Control": "public, max-age=21600, s-maxage=43200",
        },
      );
    } catch (err) {
      attempts.push({ url, error: (err as Error).message });
    }
  }

  return json(
    {
      error: "exchange_rate_unavailable",
      message:
        "Ninguna fuente de tipo de cambio respondió. El sitio usará el precio USD " +
        "hardcoded de cada propiedad como fallback.",
      attempts,
    },
    502,
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
