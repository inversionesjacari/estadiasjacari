/// <reference types="@cloudflare/workers-types" />
//
// property-photos.ts — Fotos de cada propiedad para enviar por WhatsApp.
//
// Las fotos viven en el sitio (public/images/<carpeta>/NN.ext) y se sirven
// públicamente vía HTTPS, que es lo que requiere Meta Cloud API para enviar
// imágenes por `link`.
//
// NOTA: la carpeta de fotos no siempre coincide con el slug de la propiedad
// (ej. villa-b11-palma-real → carpeta "villa-b11") y la extensión varía
// (casa-brisa es .png, el resto .jpg). Por eso el mapeo explícito abajo.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import type { PropertySlug } from "./quote-extractor";

const SITE_BASE = "https://estadiasjacari.com";

/** Cuántas fotos manda el bot al chat (las primeras N). El resto, en la galería. */
const PHOTOS_TO_SEND = 4;

/**
 * slug de propiedad → { carpeta, extensión, `cover` = orden curado de fotos }.
 *
 * `cover` es el orden de las MEJORES fotos (portada primero), espejo de
 * `src/data/properties.ts` (`images[]`). NO mandamos 01–04 a ciegas: la portada
 * de Villa B11 es la 06, la de Casa Marea la 11 y la de La Florida la 03.
 * Si cambian las fotos en el sitio, actualizar acá también (fuente: properties.ts).
 */
const PHOTO_CONFIG: Record<
  PropertySlug,
  { folder: string; ext: string; cover: string[] }
> = {
  "villa-b11-palma-real": { folder: "villa-b11", ext: "jpg", cover: ["06", "15", "01", "02"] },
  "casa-brisa": { folder: "casa-brisa", ext: "png", cover: ["01", "02", "03", "04"] },
  "casa-marea": { folder: "casa-marea", ext: "jpg", cover: ["11", "12", "10", "02"] },
  "centro-morazan": { folder: "centro-morazan", ext: "jpg", cover: ["01", "02", "03", "04"] },
  "casa-lara-townhouse": { folder: "casa-lara-townhouse", ext: "jpg", cover: ["01", "02", "03", "04"] },
  "la-florida": { folder: "la-florida", ext: "jpg", cover: ["03", "05", "02", "04"] },
  "las-gemelas-tela": { folder: "casa-brisa", ext: "png", cover: ["01", "02", "03", "04"] }, // gemelas → fotos de Casa Brisa
};

/**
 * URLs de las mejores N fotos de una propiedad (absolutas, HTTPS, portada
 * primero). Devuelve [] si el slug no es válido.
 */
export function getPropertyPhotos(slug: string): string[] {
  const cfg = PHOTO_CONFIG[slug as PropertySlug];
  if (!cfg) return [];
  return cfg.cover
    .slice(0, PHOTOS_TO_SEND)
    .map((n) => `${SITE_BASE}/images/${cfg.folder}/${n}.${cfg.ext}`);
}

/** Link a la galería completa de la propiedad en el sitio. */
export function getGalleryUrl(slug: string): string {
  return `${SITE_BASE}/propiedades/${slug}`;
}

/** ¿Tenemos fotos configuradas para este slug? */
export function hasPhotos(slug: string): boolean {
  return slug in PHOTO_CONFIG;
}
