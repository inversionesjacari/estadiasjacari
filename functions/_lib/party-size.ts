//
// party-size.ts — extrae adultos/niños/bebés de texto libre, determinístico.
//
// Necesario para el paquete "Friends Trip" (day pass cobra distinto por adulto
// y por niño; un bebé es gratis y NO cuenta ni para precio ni para cupo —
// decisión de César, 10-jul-2026). Mismo espíritu que date-parser.ts: el LLM
// entiende el lenguaje, el CÓDIGO resuelve los números.
//
// Casos reales que definen las formas soportadas:
//   · "4 adultos 2 niños 1bb" (Karen López, 10-jul)  → conteo con dígito
//   · "1 niño de 12, 2 niñas de 15" (Dime, 11-jul)   → varios grupos, edad tras "de"
//   · "3 adultos y me menores de 14 16 11 y la bebé de 2 años" (D'Karoll, 11-jul)
//     → LISTA de edades sin conteo (cada edad es UNA persona, la edad decide la
//       tarifa) + bebé sin dígito ("la bebé", "una bebé") + cantidades en palabra.
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

// Margen de capacidad para NIÑOS que comparten cama (decisión de César, 13-jul-2026).
// Los ADULTOS siempre topan el cupo; los niños que comparten cama con ellos NO cuentan,
// hasta este margen POR ENCIMA del cupo publicado. (Los bebés siguen sin contar, ver
// arriba.) Sale del caso Carolina Raudales: "11 adultos y 2 niños" en Las Gemelas (cup 12)
// → entran, porque los 2 niños duermen con los papás. Chico a propósito: sin margen
// sobre-venderíamos; con +2 metemos a lo sumo 2 niños que comparten cama.
export const CHILD_BED_SHARE_MARGIN = 2;

// El margen es MENOR en casas chicas (decisión de César, 13-jul-2026): meter +2 niños en
// una casa de 3-4 personas la sobre-estiba. Las casas grandes (cupo ≥ 6: Villa B11, Casa
// Brisa/Marea, Centro Morazán, las gemelas) toleran +2; las chicas (Casa Lara cup 4, La
// Florida cup 3) solo +1. Ajustable acá — subilo/bajalo o poné 0 para cupo estricto en
// las más chicas.
export function childBedShareMargin(capacity: number): number {
  return capacity >= 6 ? CHILD_BED_SHARE_MARGIN : 1;
}

// Cantidades en palabra (1-10): "dos adultos y tres niños" es tan común como
// "2 adultos". Solo cuentan pegadas a una categoría, igual que los dígitos.
const WORD_NUM: Record<string, number> = {
  una: 1, uno: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

const NUMS = `\\d{1,2}|${Object.keys(WORD_NUM).join("|")}`;
const CATS = "adultos?|ninos?|ninas?|menores?|hijos?|hijas?|kids?|bebes?|bb";
const AGE  = "\\d{1,2}";

// Un "grupo" del desglose = [cantidad] <categoría> [de <edad>[, <edad> y <edad>…]].
// · La cantidad puede faltar SOLO si hay edades: "menores de 14 16 11" = 3 personas
//   (una por edad). Una categoría suelta ("adultos") no cuenta nada, y un número
//   suelto sin categoría ("somos 6") tampoco — eso sigue siendo `null`.
// · Una edad seguida de una categoría NO es edad sino el conteo del grupo SIGUIENTE:
//   en "1 niño de 12, 2 niñas de 15" el "2" pertenece a las niñas (lookahead negativo).
// · "de 15" / "de 15 años" se consume como EDAD del grupo — jamás infla el conteo.
const GROUP_RE = new RegExp(
  `\\b(?:(${NUMS})\\s*)?(${CATS})` +
  `(?:\\s*de\\s*(${AGE}(?:(?:\\s*(?:,|y|e)\\s*|\\s+)(?:de\\s*)?${AGE}(?!\\s*(?:${CATS})))*)\\s*(?:anos?)?)?`,
  "g",
);

/** Extrae adultos/niños/bebés mencionados EXPLÍCITAMENTE en el mensaje. Suma TODOS
 *  los grupos (no solo el primero: "1 niño de 12, 2 niñas de 15" = 3 niños) y, si el
 *  cliente da la edad, la usa para decidir niño vs adulto (umbral 15, ver arriba).
 *  Una lista de edades sin conteo ("menores de 14 16 11") cuenta UNA persona por
 *  edad. Cada campo es null si no se mencionó (distinto de 0). */
export function extractPartySize(text: string): PartySize {
  const t = strip(text);

  let adults: number | null = null;
  let children: number | null = null;
  let babies: number | null = null;

  for (const m of t.matchAll(GROUP_RE)) {
    const count = m[1] != null ? (WORD_NUM[m[1]] ?? Number(m[1])) : null;
    const label = m[2];
    const ages  = m[3] != null ? (m[3].match(/\d{1,2}/g) ?? []).map(Number) : [];
    if (count == null && ages.length === 0) continue; // categoría suelta: nada que contar

    if (label === "bb" || label.startsWith("bebe")) {
      // Bebé es bebé por su ETIQUETA, tenga la edad que tenga ("la bebé de 2 años").
      babies = (babies ?? 0) + (count ?? ages.length);
    } else if (ages.length > 1 || (count == null && ages.length === 1)) {
      // Lista de edades ("menores de 14, 16 y 11"): cada edad es UNA persona y la
      // edad decide la tarifa — un 16+ paga adulto aunque la etiqueta diga "menores".
      for (const age of ages) {
        if (label.startsWith("adulto") || age > CHILD_MAX_AGE) {
          adults = (adults ?? 0) + 1;
        } else {
          children = (children ?? 0) + 1;
        }
      }
    } else {
      // Conteo clásico ("3 adultos", "2 niñas de 15"): count personas, edad única opcional.
      const age = ages.length === 1 ? ages[0] : null;
      if (label.startsWith("adulto") || (age != null && age > CHILD_MAX_AGE)) {
        adults = (adults ?? 0) + count!;
      } else {
        children = (children ?? 0) + count!;
      }
    }
  }

  return { adults, children, babies };
}

/** Total de personas que CUENTAN para cupo/precio (bebés excluidos). null si no hay ni adultos ni niños. */
export function partyHeadcount(p: PartySize): number | null {
  if (p.adults == null && p.children == null) return null;
  return (p.adults ?? 0) + (p.children ?? 0);
}

/** Veredicto de capacidad para una propiedad, con la política de "niños que comparten
 *  cama no topan el cupo" (decisión de César, 13-jul-2026). DETERMINÍSTICO — la
 *  capacidad es un dato exacto, no algo que se le ruega al LLM ni que el LLM improvise
 *  ("si los niños no ocupan cama caben" fue una invención del bot que contradecía la KB).
 *   · "fits"             → entra holgado (adultos + niños ≤ cupo).
 *   · "fits_shared_beds" → entra SOLO porque hasta CHILD_BED_SHARE_MARGIN niños comparten
 *                          cama (por encima del cupo publicado; el mensaje debe aclararlo).
 *   · "exceeds"          → no entra ni con el margen, O los ADULTOS solos ya pasan el cupo.
 *  Sin desglose (`adults == null`): tratamos `guests` como si fueran TODOS adultos → cupo
 *  ESTRICTO. Nunca suavizamos sin saber que el excedente son niños (evita sobre-vender a
 *  ciegas). Los bebés ya vienen excluidos de `guests`/`children`. Función pura, blindada
 *  en el golden. */
export function capacityFit(
  capacity: number,
  adults: number | null | undefined,
  children: number | null | undefined,
  guests: number | null | undefined,
): "fits" | "fits_shared_beds" | "exceeds" {
  const a = adults ?? guests ?? 0;              // sin desglose: guests cuenta como adultos
  const c = adults == null ? 0 : (children ?? 0);
  if (a > capacity) return "exceeds";           // los adultos SIEMPRE topan el cupo
  const total = a + c;
  if (total <= capacity) return "fits";
  if (total <= capacity + childBedShareMargin(capacity)) return "fits_shared_beds";
  return "exceeds";
}

/** Desglose EFECTIVO del turno para el Friends Trip: lo que el cliente dice AHORA
 *  pisa lo anterior, y lo anterior se CONSERVA si este turno no lo trae. Sin esto,
 *  el desglose dado en un turno previo se perdía en el merge genérico de quote-flow
 *  (que no conoce adults/children) y un "Ok" posterior re-disparaba
 *  package_need_party_breakdown — el bot re-preguntaba lo ya respondido (caso
 *  D'Karoll parte 2, 11-jul-2026). `changed` marca si ESTE turno aportó o modificó
 *  el desglose: el cotizador debe correr aunque el LLM no haya extraído nada nuevo,
 *  porque el desglose se parsea acá y no en el LLM. `guests` solo se recalcula
 *  cuando el turno trajo desglose (si no, null = "no tocar el guests que ya había").
 *  Función pura para blindarla en el golden. */
export function mergeFriendsTripParty(
  previous: { adults?: number | null; children?: number | null },
  text: string,
): { adults: number | null; children: number | null; guests: number | null; changed: boolean } {
  const party = extractPartySize(text);
  const adults = party.adults ?? previous.adults ?? null;
  const children = party.children ?? previous.children ?? null;
  const parsedSomething = party.adults != null || party.children != null;
  const guests = parsedSomething ? (adults ?? 0) + (children ?? 0) : null;
  const changed =
    parsedSomething &&
    (adults !== (previous.adults ?? null) || children !== (previous.children ?? null));
  return { adults, children, guests, changed };
}
