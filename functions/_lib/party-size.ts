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

// Umbral de edad para el day pass: un "niño" paga tarifa de niño (L.150) HASTA los
// 15 años inclusive; de 16 en adelante paga tarifa de ADULTO (L.250) — decisión de
// César, 11-jul-2026. Solo aplica cuando el cliente da la EDAD; si solo etiqueta
// ("1 niño") se respeta la etiqueta. El bebé sigue gratis y se identifica por su
// etiqueta (bb/bebé), no por edad.
const CHILD_MAX_AGE = 15;

// Un "grupo" del desglose = <cantidad> <categoría> [de <edad>]. La edad es opcional
// y va tras "de" (ej. "2 niñas de 15", "1 niño de 12 años"). SIN categoría no se
// cuenta: un "6 en total" suelto no es gente — el número tiene que ir pegado a
// adultos/niños/niñas/kids/bebés (por eso la edad "de 15" tampoco infla el conteo:
// se consume como edad del grupo anterior, no como personas nuevas).
const GROUP_RE =
  /\b(\d{1,2})\s*(adultos?|ninos?|ninas?|kids?|bebes?|bb)(?:\s*de\s*(\d{1,2})\s*(?:anos?)?)?/g;

/** Extrae adultos/niños/bebés mencionados EXPLÍCITAMENTE en el mensaje. Suma TODOS
 *  los grupos (no solo el primero: "1 niño de 12, 2 niñas de 15" = 3 niños) y, si el
 *  cliente da la edad, la usa para decidir niño vs adulto (umbral 15, ver arriba).
 *  Cada campo es null si no se mencionó (distinto de 0). Caso real Dime, 11-jul-2026. */
export function extractPartySize(text: string): PartySize {
  const t = strip(text);

  let adults: number | null = null;
  let children: number | null = null;
  let babies: number | null = null;

  for (const m of t.matchAll(GROUP_RE)) {
    const count = Number(m[1]);
    const label = m[2];
    const age = m[3] != null ? Number(m[3]) : null;

    if (label === "bb" || label.startsWith("bebe")) {
      babies = (babies ?? 0) + count;
    } else if (label.startsWith("adulto")) {
      adults = (adults ?? 0) + count;
    } else if (age != null && age > CHILD_MAX_AGE) {
      // El cliente lo llama niño/niña pero por edad (16+) paga tarifa de adulto.
      adults = (adults ?? 0) + count;
    } else {
      children = (children ?? 0) + count;
    }
  }

  return { adults, children, babies };
}

/** Total de personas que CUENTAN para cupo/precio (bebés excluidos). null si no hay ni adultos ni niños. */
export function partyHeadcount(p: PartySize): number | null {
  if (p.adults == null && p.children == null) return null;
  return (p.adults ?? 0) + (p.children ?? 0);
}
