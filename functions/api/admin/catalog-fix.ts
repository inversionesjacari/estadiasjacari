/// <reference types="@cloudflare/workers-types" />
//
// GET / POST /api/admin/catalog-fix
//
// Deja el catálogo de WhatsApp (Commerce Manager) ESTABLE, con la mejor PORTADA
// y con la GALERÍA COMPLETA por propiedad, apuntando a URLs `.jpg` que existen
// (no a las `.png` frágiles que la optimización borró y causaron el 131009).
//
//   GET  = DRY-RUN: lista el catálogo real (Graph API con CATALOG_ADMIN_TOKEN) y
//          muestra, por producto, cuántas imágenes tiene HOY vs las planeadas. No muta.
//   POST {confirm:true}            = aplica portada + galería (principal + hasta 10 adicionales).
//   POST {confirm:true, force:true}= re-escribe TODOS con ?v=<ts> para forzar re-fetch de Meta
//                                    (destraba un producto que quedó "obsoleto"/131009).
//
// El WHATSAPP_ACCESS_TOKEN solo tiene `whatsapp_business_messaging` → el Catalog
// API le da #100. Hace falta un System User token con `catalog_management`
// (env CATALOG_ADMIN_TOKEN, que César setea en Cloudflare; Claude nunca lo ve).
//
// Auth de ESTE endpoint: Authorization: Bearer <CRON_SECRET>.
// Status 200 SIEMPRE en errores de Meta/config (Cloudflare se come el body de un 5xx).
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
const MAX_ADDITIONAL = 10; // límite de Meta: 1 principal + 10 adicionales.

// retailer_id (content ID) → galería. `hero` = portada principal (curada mirando
// las fotos, McLovin 2026-07-14: villa-b11 05 fachada, casa-marea 10 jardín,
// casa-brisa 01 fachada, morazan/casa-lara 01). `total` = cantidad de NN.jpg en
// public/images/<folder> (contiguas 01..total, verificado). La galería = hero +
// el resto en orden, hasta 10 adicionales. Todas `.jpg` estables (guard test).
const GALLERY: Record<string, { folder: string; hero: number; total: number }> = {
  "villa-b11-palma-real": { folder: "villa-b11", hero: 5, total: 15 },
  "casa-marea": { folder: "casa-marea", hero: 10, total: 16 },
  "casa-brisa": { folder: "casa-brisa", hero: 1, total: 12 },
  "centro-morazan": { folder: "centro-morazan", hero: 1, total: 11 },
  "casa-lara-townhouse": { folder: "casa-lara-townhouse", hero: 1, total: 15 },
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Arma {main, additional[]} para una propiedad: portada + galería (máx 10 extra). */
function galleryFor(cfg: { folder: string; hero: number; total: number }): { main: string; additional: string[] } {
  const url = (n: number) => `${SITE}/images/${cfg.folder}/${pad2(n)}.jpg`;
  const main = url(cfg.hero);
  const additional: string[] = [];
  for (let i = 1; i <= cfg.total && additional.length < MAX_ADDITIONAL; i++) {
    if (i === cfg.hero) continue; // la principal no se repite en la galería
    additional.push(url(i));
  }
  return { main, additional };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

interface PlanRow {
  retailerId: string;
  productItemId: string | null;
  found: boolean;
  currentMain?: string;
  currentCount: number; // cuántas imágenes tiene HOY (principal + adicionales)
  plannedMain: string;
  plannedCount: number; // cuántas tendrá (1 + adicionales)
  needsChange: boolean;
  reviewStatus?: string;
  imageFetchStatus?: string;
  visibility?: string;
}

/** Lista el catálogo con el token de catálogo y arma el plan de portada + galería. */
async function buildPlan(env: Env): Promise<
  { ok: false; error: string; hint?: string; envKeys?: string[] } | { ok: true; plan: PlanRow[]; products: CatalogProduct[] }
> {
  if (!env.CATALOG_ADMIN_TOKEN) {
    // Diagnóstico: nombres de env vars/bindings que ve la Function (nunca valores),
    // para cazar un typo de nombre o un scope Preview vs Production.
    return {
      ok: false,
      error: "Falta CATALOG_ADMIN_TOKEN en Cloudflare Pages (la Function no la ve).",
      envKeys: Object.keys(env).sort(),
      hint:
        "Si en `envKeys` no aparece 'CATALOG_ADMIN_TOKEN' exacto, quedó con otro nombre o en scope Preview. " +
        "Seteála en Cloudflare Pages → estadiasjacari → Settings → Environment variables → Production, y redeployá.",
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
      hint: "Si menciona #100/permisos, el token no tiene catalog_management sobre este catálogo. Si menciona OAuth/expiró, generá uno nuevo.",
    };
  }
  const byRetailer = new Map((listed.products ?? []).map((p) => [p.retailerId, p]));
  const plan: PlanRow[] = Object.entries(GALLERY).map(([retailerId, cfg]) => {
    const prod = byRetailer.get(retailerId);
    const g = galleryFor(cfg);
    const plannedCount = 1 + g.additional.length;
    const currentCount = prod ? 1 + (prod.additionalImageUrls?.length ?? 0) : 0;
    return {
      retailerId,
      productItemId: prod?.id ?? null,
      found: Boolean(prod),
      currentMain: prod?.imageUrl,
      currentCount,
      plannedMain: g.main,
      plannedCount,
      // needsChange si cambia la portada O la cantidad de imágenes (p.ej. hoy 2 → 11).
      needsChange: Boolean(prod) && (prod!.imageUrl !== g.main || currentCount !== plannedCount),
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
    resumen: built.plan
      .map((p) => `${p.retailerId}: ${p.found ? `${p.currentCount} img → ${p.plannedCount} img` : "NO en catálogo"}`)
      .join(" · ") + '. Nada se modificó (dry-run). Para aplicar: POST {"confirm": true}.',
  });
};

// ── POST: aplica portada + galería ──────────────────────────────────────────
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
  if (!auth.ok) return auth.response!;

  const rl = await checkRateLimit(env, { endpoint: "admin/catalog-fix", ip: getClientIp(request), max: 10, windowSec: 60 });
  if (!rl.allowed) return json({ ok: false, error: `Rate limit: ${rl.currentCount}/60s` }, 429);

  let body: { confirm?: boolean; force?: boolean } = {};
  try {
    body = (await request.json()) as { confirm?: boolean; force?: boolean };
  } catch { /* body vacío → confirm falso */ }
  if (body.confirm !== true) {
    return json({ ok: false, error: 'Falta {"confirm": true} en el body para aplicar los cambios.' }, 400);
  }

  const built = await buildPlan(env);
  if (!built.ok) return json({ mode: "apply", ...built });

  // force=true: re-escribe TODOS con ?v=<ts> para forzar a Meta re-descargar las
  // imágenes (destraba un producto "obsoleto"/131009). El query param es cosmético
  // (el archivo resuelve igual) y se auto-limpia en el próximo apply normal.
  const force = body.force === true;
  const bust = force ? `?v=${Date.now()}` : "";

  const token = env.CATALOG_ADMIN_TOKEN!;
  const results: Array<{ retailerId: string; ok: boolean; detail: string }> = [];
  for (const row of built.plan) {
    if (!row.found || !row.productItemId) {
      results.push({ retailerId: row.retailerId, ok: false, detail: "no está en el catálogo (skip)" });
      continue;
    }
    if (!force && !row.needsChange) {
      results.push({ retailerId: row.retailerId, ok: true, detail: `ya tenía ${row.currentCount} imágenes correctas (skip)` });
      continue;
    }
    const cfg = GALLERY[row.retailerId];
    const g = galleryFor(cfg);
    const main = `${g.main}${bust}`;
    const additional = g.additional.map((u) => `${u}${bust}`);
    const res = await updateProductImage(row.productItemId, main, token, additional);
    results.push({
      retailerId: row.retailerId,
      ok: res.ok,
      detail: res.ok
        ? `${1 + additional.length} imágenes (portada + ${additional.length} galería)${force ? " · re-fetch forzado" : ""}`
        : (res.error || "error desconocido"),
    });
  }

  const okCount = results.filter((r) => r.ok).length;
  return json({
    ok: results.every((r) => r.ok),
    mode: "apply",
    catalogId: env.WHATSAPP_CATALOG_ID,
    results,
    resumen: `${okCount}/${results.length} OK. Meta puede tardar unos minutos en reflejar las imágenes.`,
  });
};
