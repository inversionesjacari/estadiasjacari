/// <reference types="@cloudflare/workers-types" />
//
// GET / POST /api/admin/catalog-fix
//
// Deja el catálogo de WhatsApp (Commerce Manager) ESTABLE y con la MEJOR portada
// por propiedad, apuntando a URLs `.jpg` que existen (no a las `.png` frágiles que
// la optimización de imágenes borró y que causaron el 131009 / "producto obsoleto").
//
//   GET  = DRY-RUN: lista el catálogo real (vía Graph API con CATALOG_ADMIN_TOKEN)
//          y muestra, por producto, la portada ACTUAL vs la PLANEADA. No cambia nada.
//   POST = APLICA: cambia la imagen principal de cada producto a su mejor portada.
//          Requiere body {"confirm": true} para evitar mutaciones accidentales.
//
// Por qué un token aparte: el WHATSAPP_ACCESS_TOKEN solo tiene
// `whatsapp_business_messaging` → el Catalog API le responde #100 "app not approved".
// Para leer/escribir el catálogo hace falta un System User token con
// `catalog_management`, que César genera en Meta Business Settings y setea en
// Cloudflare Pages como CATALOG_ADMIN_TOKEN (Claude nunca lo ve).
//
// Auth de ESTE endpoint: Authorization: Bearer <CRON_SECRET> (igual que el resto de /admin).
//
// Status 200 SIEMPRE en errores de Meta/config (no 5xx): Cloudflare se come el body
// de un 502/503/504 y esconde justo el veredicto — el campo `ok` es el canal real.
//

import { listCatalogProducts, updateProductImage, type CatalogProduct } from "../../_lib/whatsapp";
import { checkRateLimit, getClientIp } from "../../_lib/rate-limit";
import { requireBearerAuth } from "../../_lib/admin-auth";

interface Env {
  DB: D1Database;
  CRON_SECRET?: string;
  WHATSAPP_CATALOG_ID?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  /** System User token con catalog_management (Meta Business Settings). */
  CATALOG_ADMIN_TOKEN?: string;
}

const SITE = "https://estadiasjacari.com";

// retailer_id (content ID) → mejor foto de portada (curada mirando las fotos).
// Todas son `.jpg` que existen en public/images (estables, cubiertas por el guard
// test de _redirects). Elegidas por McLovin 2026-07-14:
//   villa-b11    05 = fachada tropical con palmeras (antes: comedor)
//   casa-marea   10 = jardín/sombrilla/palmeras (antes: baño viejo)
//   casa-brisa   01 = fachada coral con cielo azul (ya era la mejor)
//   morazan      01 = habitación limpia y ordenada
//   casa-lara    01 = habitación limpia con TV
const BEST_IMAGE: Record<string, string> = {
  "villa-b11-palma-real": `${SITE}/images/villa-b11/05.jpg`,
  "casa-marea": `${SITE}/images/casa-marea/10.jpg`,
  "casa-brisa": `${SITE}/images/casa-brisa/01.jpg`,
  "centro-morazan": `${SITE}/images/centro-morazan/01.jpg`,
  "casa-lara-townhouse": `${SITE}/images/casa-lara-townhouse/01.jpg`,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

interface PlanRow {
  retailerId: string;
  productItemId: string | null;
  currentImage?: string;
  plannedImage: string;
  found: boolean;
  needsChange: boolean;
  /** Elegibilidad para la tarjeta nativa: si NO es approved/published/success, cae a fallback. */
  reviewStatus?: string;
  imageFetchStatus?: string;
  visibility?: string;
}

/** Lista el catálogo con el token de catálogo y arma el plan portada-actual→planeada. */
async function buildPlan(env: Env): Promise<
  { ok: false; error: string; hint?: string; envKeys?: string[] } | { ok: true; plan: PlanRow[]; products: CatalogProduct[] }
> {
  if (!env.CATALOG_ADMIN_TOKEN) {
    // Diagnóstico: listamos los NOMBRES de las env vars/bindings que la Function
    // ve (nunca los valores) para cazar un typo de nombre o un scope equivocado.
    const envKeys = Object.keys(env).sort();
    return {
      ok: false,
      error: "Falta CATALOG_ADMIN_TOKEN en Cloudflare Pages (la Function no la ve).",
      envKeys,
      hint:
        "Revisá en la lista `envKeys` de arriba: si no aparece 'CATALOG_ADMIN_TOKEN' exacto, la variable " +
        "quedó con otro nombre o en el scope Preview en vez de Production. Seteála en Cloudflare Pages → " +
        "estadiasjacari → Settings → Environment variables → pestaña Production, nombre EXACTO CATALOG_ADMIN_TOKEN, y redeployá.",
    };
  }
  const listed = await listCatalogProducts(
    { WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN, WHATSAPP_CATALOG_ID: env.WHATSAPP_CATALOG_ID },
    env.CATALOG_ADMIN_TOKEN,
  );
  if (!listed.ok) {
    return {
      ok: false,
      error: listed.error || "No se pudo listar el catálogo.",
      hint:
        "Si el error menciona #100 / permisos, el CATALOG_ADMIN_TOKEN no tiene catalog_management sobre este catálogo. " +
        "Si menciona OAuth/expiró, generá un token nuevo.",
    };
  }
  const byRetailer = new Map((listed.products ?? []).map((p) => [p.retailerId, p]));
  const plan: PlanRow[] = Object.entries(BEST_IMAGE).map(([retailerId, plannedImage]) => {
    const prod = byRetailer.get(retailerId);
    return {
      retailerId,
      productItemId: prod?.id ?? null,
      currentImage: prod?.imageUrl,
      plannedImage,
      found: Boolean(prod),
      needsChange: Boolean(prod) && prod!.imageUrl !== plannedImage,
      reviewStatus: prod?.reviewStatus,
      imageFetchStatus: prod?.imageFetchStatus,
      visibility: prod?.visibility,
    };
  });
  return { ok: true, plan, products: listed.products ?? [] };
}

// ── GET: dry-run (no muta nada) ─────────────────────────────────────────────
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  const rl = await checkRateLimit(env, { endpoint: "admin/catalog-fix", ip: getClientIp(request), max: 10, windowSec: 60 });
  if (!rl.allowed) return json({ ok: false, error: `Rate limit: ${rl.currentCount}/60s` }, 429);

  const built = await buildPlan(env);
  if (!built.ok) return json({ mode: "dry-run", ...built });

  return json({
    ok: true,
    mode: "dry-run",
    catalogId: env.WHATSAPP_CATALOG_ID,
    plan: built.plan,
    resumen: `${built.plan.filter((p) => p.needsChange).length} de ${built.plan.length} productos cambiarían de portada. Nada se modificó (dry-run). Para aplicar: POST con {"confirm": true}.`,
  });
};

// ── POST: aplica los cambios ────────────────────────────────────────────────
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  const rl = await checkRateLimit(env, { endpoint: "admin/catalog-fix", ip: getClientIp(request), max: 10, windowSec: 60 });
  if (!rl.allowed) return json({ ok: false, error: `Rate limit: ${rl.currentCount}/60s` }, 429);

  let body: { confirm?: boolean } = {};
  try {
    body = (await request.json()) as { confirm?: boolean };
  } catch { /* body vacío → confirm falso */ }
  if (body.confirm !== true) {
    return json({ ok: false, error: 'Falta {"confirm": true} en el body para aplicar los cambios.' }, 400);
  }

  const built = await buildPlan(env);
  if (!built.ok) return json({ mode: "apply", ...built });

  const token = env.CATALOG_ADMIN_TOKEN!;
  const results: Array<{ retailerId: string; ok: boolean; detail: string }> = [];
  for (const row of built.plan) {
    if (!row.found || !row.productItemId) {
      results.push({ retailerId: row.retailerId, ok: false, detail: "no está en el catálogo (skip)" });
      continue;
    }
    if (!row.needsChange) {
      results.push({ retailerId: row.retailerId, ok: true, detail: "ya tenía la portada correcta (skip)" });
      continue;
    }
    const res = await updateProductImage(row.productItemId, row.plannedImage, token);
    results.push({
      retailerId: row.retailerId,
      ok: res.ok,
      detail: res.ok ? `portada → ${row.plannedImage}` : (res.error || "error desconocido"),
    });
  }

  const okCount = results.filter((r) => r.ok).length;
  return json({
    ok: results.every((r) => r.ok),
    mode: "apply",
    catalogId: env.WHATSAPP_CATALOG_ID,
    results,
    resumen: `${okCount}/${results.length} OK. Meta puede tardar unos minutos en reflejar la portada; si un producto seguía "obsoleto", esto además lo re-valida.`,
  });
};
