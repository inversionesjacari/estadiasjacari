/// <reference types="@cloudflare/workers-types" />
//
// GET /api/admin/catalog-check
//
// Diagnóstico definitivo del catálogo NATIVO de WhatsApp (continuación de
// CATALOGO-INSTR, 2026-07-12): la instrumentación de `catalog-trace.ts` mostró
// `CATALOG_CARD_FALLBACK` con error 131009 "product not found" para
// villa-b11-palma-real y centro-morazan, mientras casa-brisa SÍ salió — pese a
// que Commerce Manager (la pantalla) muestra las 5 propiedades como
// "Disponible". Eso solo pasa si `env.WHATSAPP_CATALOG_ID` apunta a un
// catalog_id que NO es el catálogo que se ve en esa pantalla (ej. quedó un ID
// viejo/de otro catálogo configurado en Cloudflare Pages).
//
// Este endpoint le pregunta DIRECTO a la Graph API (`listCatalogProducts`,
// misma fuente que usa `sendProductMessage`) qué retailer_id existen de
// verdad en ESE catalog_id, y los cruza contra las 7 propiedades del sitio.
// Reemplaza "yo creo que sí lo hice bien" (lectura de pantalla) por una
// respuesta exacta.
//
// Auth: Authorization: Bearer <CRON_SECRET>  (mismo patrón que el resto de /admin)
//
// Uso:
//   curl https://estadiasjacari.com/api/admin/catalog-check \
//     -H "Authorization: Bearer $CRON_SECRET"
//

import { listCatalogProducts } from "../../_lib/whatsapp";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_CATALOG_ID?: string;
}

// Slugs canónicos = quote-builder.ts. la-florida y las-gemelas-tela quedaron
// dormidos a propósito (César, JACARI_MEMORY 2026-07-11) — nunca se subieron a
// Commerce Manager, así que faltar ahí NO es una alarma.
const ALL_SLUGS = [
  "villa-b11-palma-real",
  "casa-brisa",
  "casa-marea",
  "centro-morazan",
  "casa-lara-townhouse",
  "las-gemelas-tela",
  "la-florida",
] as const;
const KNOWN_DORMANT = new Set<string>(["las-gemelas-tela", "la-florida"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Auth (timing-safe Bearer compare via helper compartido)
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  // 2. Rate limit (patrón compartido de /admin)
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, {
    endpoint: "admin/catalog-check",
    ip,
    max: 10,
    windowSec: 60,
  });
  if (!rl.allowed) {
    return json(
      { ok: false, error: `Rate limit: ${rl.currentCount} requests en 60s. Reintenta en ${rl.retryAfterSec}s.` },
      429,
    );
  }

  // 3. Preguntarle a la Graph API qué hay REALMENTE en el catalog_id configurado
  const result = await listCatalogProducts({
    WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_CATALOG_ID: env.WHATSAPP_CATALOG_ID,
  });

  if (!result.ok) {
    // Status 200 A PROPÓSITO: Cloudflare intercepta 502/503/504 de un Pages
    // Function y los reemplaza con su página genérica `error code: 502`,
    // TRAGÁNDOSE el body. En un endpoint de diagnóstico eso esconde justo lo
    // que venimos a ver (el error EXACTO de Meta). El status HTTP no es el canal
    // del veredicto acá — el campo `ok` sí. (Aprendido: 401/429 pasan; 5xx no.)
    return json(
      {
        ok: false,
        catalogId: env.WHATSAPP_CATALOG_ID ?? null,
        error: result.error,
        pista:
          "La consulta a la Graph API de Meta falló. Si el error menciona token/OAuth, el WHATSAPP_ACCESS_TOKEN de Cloudflare Pages venció (los de usuario duran ~60 días). Si menciona el catalog_id o permisos, el token no tiene alcance sobre ese catálogo.",
      },
      200,
    );
  }

  // 4. Cruzar contra las 7 propiedades del sitio
  const foundIds = new Set((result.products ?? []).map((p) => p.retailerId));
  const checklist = ALL_SLUGS.map((slug) => ({
    slug,
    enEsteCatalogo: foundIds.has(slug),
    dormidoAPropósito: KNOWN_DORMANT.has(slug),
  }));
  const faltantesInesperados = checklist.filter((c) => !c.enEsteCatalogo && !c.dormidoAPropósito);

  return json({
    ok: true,
    catalogId: env.WHATSAPP_CATALOG_ID,
    totalProductosEnMeta: result.products?.length ?? 0,
    productosEnMeta: result.products,
    checklist,
    veredicto:
      faltantesInesperados.length === 0
        ? "✅ Las 5 propiedades activas SÍ están cargadas en el catalog_id que usa el bot — si igual cae a fallback, el problema es otro (revisión de Meta pendiente, ventana de 24h, etc.)."
        : `🔴 Faltan en catalog_id ${env.WHATSAPP_CATALOG_ID}: ${faltantesInesperados.map((c) => c.slug).join(", ")}. ` +
          `Esto pasa cuando WHATSAPP_CATALOG_ID (Cloudflare Pages → env vars) apunta a un catálogo distinto al que ves en Commerce Manager. ` +
          `Confirmá el catalog_id correcto en Meta Commerce Manager → Configuración del catálogo → "ID del catálogo" y compará contra el de arriba.`,
  });
};
