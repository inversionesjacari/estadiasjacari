//
// event-pricing.ts — Rate card del venue de EVENTOS de Valle de Ángeles (renta del
// espacio, en Lempiras). Módulo PURO (sin D1/LLM): estructura → precio. Testeable en
// aislamiento (event-pricing.test.ts, verificado contra los ejemplos del doc
// `05_automatizacion/13_venue_valle_de_angeles_estructura_cobro.md` §2.3).
//
// QUÉ EXPONE EL BOT: solo un "DESDE" (piso comunicable) + un estimado preliminar.
// El bot NUNCA cierra el precio final de un evento — da rango, captura el intake y
// escala a humano (César lo confirma). Los costos internos y el split 60/40 de la
// dueña (doña Bárbara) NO viven acá: no afectan el precio al cliente y son privados.
//
// FÓRMULA (doc 13 §2):
//   PRECIO = round100( max( BASE(pax) × MULT_TIPO × MULT_DIA × MULT_TEMP , 9000 ) )
//
// El precio no puede ser lineal: los costos fijos dominan (un evento de 20 pax cuesta
// operar casi lo mismo que uno de 80), por eso la base escala por BANDAS, no por
// proporción, y hay un piso duro de L9,000.
//

export type EventType = "boda" | "xv" | "corporativo" | "social";
export type EventDay = "sabado" | "viernes" | "domingo" | "entre_semana";
export type EventSeason = "alta" | "estandar" | "baja";

/** Capacidad máxima del venue (pax). >100 → el bot no estima, deriva al equipo.
 *  100 es el TECHO de la rate card; el número EXACTO de sentados lo confirma César
 *  (hoy el placeholder de la KB es 80). */
export const EVENT_CAPACITY_MAX = 100;

/** Piso duro: ningún evento cobra menos (protege el margen de los eventos chicos). */
export const EVENT_PRICE_FLOOR_HNL = 9000;

/** Base por banda de tamaño, definida sobre la referencia (sábado · social ·
 *  temporada estándar). Pares [tope_de_pax, renta_base]. Ordenados ascendente. */
export const EVENT_BASE_BANDS: ReadonlyArray<readonly [number, number]> = [
  [20, 10000],
  [40, 14000],
  [60, 18000],
  [80, 22000],
  [100, 26000],
];

export const MULT_TIPO: Record<EventType, number> = {
  corporativo: 0.85,
  social: 1.0,
  xv: 1.35,
  boda: 1.7,
};

export const MULT_DIA: Record<EventDay, number> = {
  sabado: 1.0,
  viernes: 0.9,
  domingo: 0.9,
  entre_semana: 0.8,
};

export const MULT_TEMP: Record<EventSeason, number> = {
  alta: 1.15, // nov–abr + fechas pico
  estandar: 1.0,
  baja: 0.85, // lluvia may–oct
};

/** Redondeo al múltiplo de 100 más cercano (el doc 13 comunica precios así: 43,010→
 *  43,000; 9,520→9,500; 50,830→50,800). */
function roundTo100(n: number): number {
  return Math.round(n / 100) * 100;
}

/**
 * Renta base para una cantidad de pax. `null` si `pax` no es válido o supera el
 * techo del venue (>100 → hay que derivar al equipo, no estimar).
 */
export function eventBaseForPax(pax: number): number | null {
  if (!Number.isFinite(pax) || pax <= 0) return null;
  for (const [cap, base] of EVENT_BASE_BANDS) {
    if (pax <= cap) return base;
  }
  return null; // > EVENT_CAPACITY_MAX
}

/**
 * Precio de renta del espacio por la fórmula del doc 13. `day`/`season` por defecto
 * = la referencia de la tabla base (sábado · estándar). Devuelve `null` si pax
 * está fuera de rango (>100 o inválido) → el bot escala en vez de estimar.
 *
 * Verificado contra los 7 ejemplos de §2.3 (ver event-pricing.test.ts).
 */
export function computeEventPrice(args: {
  pax: number;
  type: EventType;
  day?: EventDay;
  season?: EventSeason;
}): number | null {
  const base = eventBaseForPax(args.pax);
  if (base === null) return null;
  const day = args.day ?? "sabado";
  const season = args.season ?? "estandar";
  const raw = base * MULT_TIPO[args.type] * MULT_DIA[day] * MULT_TEMP[season];
  return roundTo100(Math.max(raw, EVENT_PRICE_FLOOR_HNL));
}

/**
 * "Desde" editorial por tipo cuando NO sabemos cuántas personas son (doc 13 §2.4 —
 * "lo que el bot dice sin comprometer número final"). Derivado de la fórmula a
 * (pax representativo · sábado · temporada BAJA), que es la convención del doc:
 *   boda:        computeEventPrice(80, 'boda', 'sabado', 'baja') = 31,800
 *   xv:          computeEventPrice(60, 'xv',   'sabado', 'baja') = 20,700
 *   corp/social: piso duro                                        =  9,000
 * (La igualdad con la fórmula está blindada en event-pricing.test.ts.)
 */
export const EVENT_DESDE_BY_TYPE: Record<EventType, number> = {
  boda: 31800,
  xv: 20700,
  corporativo: 9000,
  social: 9000,
};

/**
 * El número "DESDE" (piso comunicable) que muestra el bot:
 *   - con pax conocido → la fórmula para ESA cantidad, en su config más barata de un
 *     sábado típico (sábado · temporada baja) → un "desde" honesto para su tamaño.
 *   - sin pax → el "desde" editorial por tipo (arriba).
 * Siempre es un PISO ("desde"), nunca un precio cerrado; el bot lo acompaña de "el
 * equipo confirma el precio final según la fecha y los detalles".
 */
export function eventDesdeHnl(type: EventType, pax?: number | null): number {
  if (typeof pax === "number" && pax > 0) {
    const p = computeEventPrice({ pax, type, day: "sabado", season: "baja" });
    if (p !== null) return p; // pax > 100 cae al editorial (el handler escala igual)
  }
  return EVENT_DESDE_BY_TYPE[type];
}

/** Formatea un monto en Lempiras al estilo del resto del bot ("L.31,800"). */
export function formatEventHnl(n: number): string {
  return `L.${n.toLocaleString("es-HN")}`;
}
