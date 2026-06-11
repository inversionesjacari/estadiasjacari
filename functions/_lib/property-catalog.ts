/// <reference types="@cloudflare/workers-types" />
//
// property-catalog.ts — Tarjeta rica de cada propiedad para WhatsApp.
//
// Convierte un slug en un mensaje con la info que vende: emoji + nombre + ciudad,
// una línea de gancho, los features estrella, capacidad, precio "desde" y el link
// a la galería + reserva. Así el bot DA la info directamente en vez de mandar
// fotos sueltas con un "te mando unas fotos 📸".
//
// Reusa PROPERTY_PRICING (quote-builder = única fuente de precios del bot) y solo
// agrega acá el copy de venta (tagline + features) por propiedad. Las fotos se
// mandan aparte (ver property-photos.ts / getPropertyPhotos).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import type { PropertySlug } from "./quote-extractor";
import type { Lang } from "./i18n";
import { PROPERTY_PRICING } from "./quote-builder";
import { getGalleryUrl } from "./property-photos";

interface CardInfo {
  emoji: string;
  taglineEs: string;
  taglineEn: string;
  /** Features estrella, ya unidas con " · " (cortas, escaneables en WhatsApp). */
  featuresEs: string;
  featuresEn: string;
}

const CARD_INFO: Record<PropertySlug, CardInfo> = {
  "villa-b11-palma-real": {
    emoji: "🏖️",
    taglineEs: "Villa privada con resort incluido en La Ceiba",
    taglineEn: "Private villa with full resort access in La Ceiba",
    featuresEs: "Piscina y playa del hotel incluidas · A/C · asador en terraza · cocina equipada",
    featuresEn: "Hotel pool & beach included · A/C · terrace grill · full kitchen",
  },
  "casa-brisa": {
    emoji: "🌊",
    taglineEs: "Casa frente al Caribe en Tela",
    taglineEn: "Beach house steps from the Caribbean in Tela",
    featuresEs: "A pasos del mar · WiFi dual · generador propio · asador en jardín",
    featuresEn: "Steps from the sea · dual WiFi · backup generator · garden grill",
  },
  "casa-marea": {
    emoji: "🌊",
    taglineEs: "Escapada al Caribe en Tela",
    taglineEn: "Caribbean getaway in Tela",
    featuresEs: "A pasos del mar · WiFi dual · generador propio · asador en jardín",
    featuresEn: "Steps from the sea · dual WiFi · backup generator · garden grill",
  },
  "las-gemelas-tela": {
    emoji: "🏠🏠",
    taglineEs: "Las Gemelas de Tela — dos casas para grupos grandes",
    taglineEn: "The Tela Twins — two houses for big groups",
    featuresEs: "Hasta 12 personas · a pasos del mar · WiFi dual · generador propio",
    featuresEn: "Up to 12 guests · steps from the sea · dual WiFi · backup generator",
  },
  "centro-morazan": {
    emoji: "🏙️",
    taglineEs: "Apartamento de lujo en el centro de Tegucigalpa",
    taglineEn: "Luxury apartment in central Tegucigalpa",
    featuresEs: "Piso 20 con vistas panorámicas · A/C · estacionamiento · céntrico",
    featuresEn: "20th floor, panoramic views · A/C · parking · central",
  },
  "casa-lara-townhouse": {
    emoji: "🛏️",
    taglineEs: "Townhouse moderno en Colonia Lara",
    taglineEn: "Modern townhouse in Colonia Lara",
    featuresEs: "Cada cuarto con baño privado · A/C · zona exclusiva · estacionamiento",
    featuresEn: "Each room with private bath · A/C · upscale area · parking",
  },
  "la-florida": {
    emoji: "🧺",
    taglineEs: "Acogedor y económico en Tegucigalpa",
    taglineEn: "Cozy and budget-friendly in Tegucigalpa",
    featuresEs: "Lavadora y secadora · seguridad 24/7 · cocina equipada · A/C",
    featuresEn: "Washer & dryer · 24/7 security · full kitchen · A/C",
  },
};

/** Formato HNL con separador de miles (espejo de quote-builder). */
function fmtHnl(n: number): string {
  return `HNL ${n.toLocaleString("es-HN")}`;
}

/**
 * Tarjeta rica de una propiedad lista para WhatsApp: emoji + nombre + ciudad,
 * gancho, features estrella, capacidad, precio "desde" y link a galería + reserva.
 * Devuelve "" si el slug no existe (el caller cae al texto genérico).
 */
export function buildPropertyCard(slug: string, lang: Lang = "es"): string {
  const info = CARD_INFO[slug as PropertySlug];
  const pricing = PROPERTY_PRICING[slug as PropertySlug];
  if (!info || !pricing) return "";
  const url = getGalleryUrl(slug);

  if (lang === "en") {
    return `${info.emoji} *${pricing.name}* · ${pricing.city}
${info.taglineEn}

✨ ${info.featuresEn}
👥 Up to ${pricing.capacity} guests · 💰 from *${fmtHnl(pricing.pricePerNightHNL)}*/night

📸 See all the photos & book here 👇
${url}`;
  }

  return `${info.emoji} *${pricing.name}* · ${pricing.city}
${info.taglineEs}

✨ ${info.featuresEs}
👥 Hasta ${pricing.capacity} huéspedes · 💰 desde *${fmtHnl(pricing.pricePerNightHNL)}*/noche

📸 Mirá todas las fotos y reservá acá 👇
${url}`;
}
