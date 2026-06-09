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

/** slug de propiedad → { carpeta de imágenes, extensión, total de fotos disponibles } */
const PHOTO_CONFIG: Record<PropertySlug, { folder: string; ext: string }> = {
  "villa-b11-palma-real": { folder: "villa-b11", ext: "jpg" },
  "casa-brisa": { folder: "casa-brisa", ext: "png" },
  "casa-marea": { folder: "casa-marea", ext: "jpg" },
  "centro-morazan": { folder: "centro-morazan", ext: "jpg" },
  "casa-lara-townhouse": { folder: "casa-lara-townhouse", ext: "jpg" },
  "la-florida": { folder: "la-florida", ext: "jpg" },
  "las-gemelas-tela": { folder: "casa-brisa", ext: "png" }, // gemelas → fotos de Casa Brisa
};

/**
 * URLs de las primeras N fotos de una propiedad (absolutas, HTTPS).
 * Devuelve [] si el slug no es válido.
 */
export function getPropertyPhotos(slug: string): string[] {
  const cfg = PHOTO_CONFIG[slug as PropertySlug];
  if (!cfg) return [];
  const urls: string[] = [];
  for (let i = 1; i <= PHOTOS_TO_SEND; i++) {
    const n = String(i).padStart(2, "0");
    urls.push(`${SITE_BASE}/images/${cfg.folder}/${n}.${cfg.ext}`);
  }
  return urls;
}

/** Link a la galería completa de la propiedad en el sitio. */
export function getGalleryUrl(slug: string): string {
  return `${SITE_BASE}/propiedades/${slug}`;
}

/** ¿Tenemos fotos configuradas para este slug? */
export function hasPhotos(slug: string): boolean {
  return slug in PHOTO_CONFIG;
}
