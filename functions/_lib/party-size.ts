//
// party-size.ts — extrae adultos/niños/bebés de texto libre, determinístico.
//
// Necesario para el paquete "Friends Trip" (day pass cobra distinto por adulto
// y por niño; un bebé es gratis y NO cuenta ni para precio ni para cupo —
// decisión de César, 10-jul-2026). Mismo espíritu que date-parser.ts: el LLM
// entiende el lenguaje, el CÓDIGO resuelve los números.
//
// Caso real: "4 adultos 2 niños 1bb" (Karen López) → adults=4, children=2,
// babies=1 (excluido del total).
//

export interface PartySize {
  adults: number | null;
  children: number | null;
  babies: number | null;
}

function strip(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Extrae adultos/niños/bebés mencionados EXPLÍCITAMENTE en el mensaje. */
export function extractPartySize(text: string): PartySize {
  const t = strip(text);

  let adults: number | null = null;
  let m = t.match(/\b(\d{1,2})\s*adultos?\b/);
  if (m) adults = Number(m[1]);

  let children: number | null = null;
  m = t.match(/\b(\d{1,2})\s*(?:ninos?|ninas?|kids?)\b/);
  if (m) children = Number(m[1]);

  let babies: number | null = null;
  m = t.match(/\b(\d{1,2})\s*(?:bb|bebes?)\b/);
  if (m) babies = Number(m[1]);

  return { adults, children, babies };
}

/** Total de personas que CUENTAN para cupo/precio (bebés excluidos). null si no hay ni adultos ni niños. */
export function partyHeadcount(p: PartySize): number | null {
  if (p.adults == null && p.children == null) return null;
  return (p.adults ?? 0) + (p.children ?? 0);
}
