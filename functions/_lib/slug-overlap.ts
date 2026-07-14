//
// slug-overlap.ts — Expansión de slugs que comparten inventario FÍSICO.
//
// "las-gemelas-tela" no es una casa: es Casa Brisa + Casa Marea alquiladas
// JUNTAS. Una reserva del combo ocupa ambas casas; una reserva de cualquiera
// de las dos casas rompe el combo. Todo chequeo anti-doble-reserva en D1 que
// filtre `WHERE property_slug = ?` (slug exacto) tiene un hueco: la reserva
// 'las-gemelas-tela' no bloquea un comprobante/pago/cotización de 'casa-marea'
// para las mismas fechas, ni al revés → doble venta cruzada (hallazgo residual
// de DOCTOR-PROOF-1205, 13-jul-2026). El cross-block SÍ existía a nivel iCal
// (SLUG_TO_SOURCES mezcla el calendario de LAS_GEMELAS en brisa/marea), pero
// las reservas que viven solo en D1 (bot, transferencia, website) lo esquivaban.
//
// Este módulo es la fuente ÚNICA de esa expansión: en los overlaps D1 usar
// `property_slug IN (${slugPlaceholders(slugs)})` con `overlapSlugs(slug)`.
//
// OJO: casa-brisa NO bloquea casa-marea (son casas separadas) — solo el combo
// cruza hacia las unidades y cada unidad hacia el combo.

export const GEMELAS_COMBO_SLUG = "las-gemelas-tela";
export const GEMELAS_UNIT_SLUGS = ["casa-brisa", "casa-marea"] as const;

/**
 * Slugs cuyas reservas ocupan (total o parcialmente) el mismo inventario
 * físico que `slug`. Incluye siempre el propio slug, primero. Puro.
 */
export function overlapSlugs(slug: string): string[] {
  if (slug === GEMELAS_COMBO_SLUG) return [GEMELAS_COMBO_SLUG, ...GEMELAS_UNIT_SLUGS];
  if ((GEMELAS_UNIT_SLUGS as readonly string[]).includes(slug)) return [slug, GEMELAS_COMBO_SLUG];
  return [slug];
}

/** "?, ?, ?" para armar `property_slug IN (...)` con los slugs expandidos. */
export function slugPlaceholders(slugs: readonly string[]): string {
  return slugs.map(() => "?").join(", ");
}
