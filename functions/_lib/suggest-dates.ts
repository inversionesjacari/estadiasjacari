//
// suggest-dates.ts — Motor determinístico de SUGERENCIA de fechas alternativas.
//
// Cuando la propiedad NO está disponible para las fechas pedidas, el bot no debe
// limitarse a decir "no disponible, ¿querés otras fechas?" y quedarse esperando
// (lead frío). César pidió que PROPONGA el calendario:
//   1) la ventana libre MÁS CERCANA a lo que pidió (mismo largo de estadía), y
//   2) otros FINES DE SEMANA disponibles (mismo día-de-semana de entrada).
//
// Esto es matemática de calendario pura → va a CÓDIGO, no al prompt (ver
// references/metodo-eval-driven.md). La función núcleo `findAlternativeDates` es
// PURA: recibe el set de fechas ocupadas (`blocked`, que en producción viene de
// `getBlockedDates` en availability.ts — la MISMA fuente con la que el bot ya
// decide "no disponible") y devuelve ventanas libres. Al ser pura se testea al
// instante, sin red ni D1 (por eso NO importa availability.ts, que trae `ical.js`).
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

import { addDaysIso } from "./date-parser";
import { nightsBetween } from "./detectors";
import type { Lang } from "./i18n";

/** Una ventana de estadía candidata (check-in inclusivo, check-out exclusivo). */
export interface DateWindow {
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD (día de salida; esa noche queda libre)
  nights: number;
}

export interface AltDates {
  /** La ventana libre más cercana a la pedida (mismo nº de noches). */
  nearest: DateWindow | null;
  /** Fines de semana libres (mismo día-de-semana de entrada), futuros. */
  weekends: DateWindow[];
}

export interface FindAltOpts {
  /** Días a explorar hacia ambos lados del check-in pedido (default 60). */
  horizonDays?: number;
  /** Cuántos fines de semana alternativos devolver (default 2). */
  maxWeekends?: number;
  /** Semanas hacia adelante a explorar para los fines de semana (default 26). */
  weekendHorizonWeeks?: number;
}

/** {y, m, d, dow} de un ISO en UTC (dow: 0=domingo … 6=sábado). */
function parts(iso: string): { y: number; m: number; d: number; dow: number } {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, dow };
}

/**
 * Encuentra fechas alternativas libres alrededor de lo que el cliente pidió.
 *
 * @param blocked         Set de fechas ISO ocupadas (de getBlockedDates: iCal + D1).
 * @param requestedCheckIn  ISO de la entrada pedida (ya ocupada).
 * @param requestedCheckOut ISO de la salida pedida.
 * @param todayIso        Hoy (para nunca proponer fechas pasadas).
 */
export function findAlternativeDates(
  blocked: Set<string>,
  requestedCheckIn: string,
  requestedCheckOut: string,
  todayIso: string,
  opts: FindAltOpts = {},
): AltDates {
  const nights = Math.max(1, nightsBetween(requestedCheckIn, requestedCheckOut));
  const horizonDays = opts.horizonDays ?? 60;
  const maxWeekends = opts.maxWeekends ?? 2;
  const weekendHorizonWeeks = opts.weekendHorizonWeeks ?? 26;

  // ¿Están libres TODAS las noches [ci, ci+nights)?
  const isFree = (ci: string): boolean => {
    for (let i = 0; i < nights; i++) {
      if (blocked.has(addDaysIso(ci, i))) return false;
    }
    return true;
  };
  const notPast = (ci: string): boolean => ci >= todayIso;

  // ── 1. Más cercana: escaneo por distancia creciente al check-in pedido.
  // off=0,1,2,…: probamos +off (futuro) ANTES que -off → en empate gana la fecha
  // futura. La primera ventana libre y no-pasada gana.
  let nearest: DateWindow | null = null;
  for (let off = 0; off <= horizonDays && !nearest; off++) {
    const candidates =
      off === 0
        ? [requestedCheckIn]
        : [addDaysIso(requestedCheckIn, off), addDaysIso(requestedCheckIn, -off)];
    for (const ci of candidates) {
      if (notPast(ci) && isFree(ci)) {
        nearest = { checkIn: ci, checkOut: addDaysIso(ci, nights), nights };
        break;
      }
    }
  }

  // ── 2. Otros fines de semana: mismo día-de-semana de entrada (si el pedido cae
  // jue/vie/sáb) o viernes por defecto, en semanas futuras.
  const reqDow = parts(requestedCheckIn).dow;
  const anchorDow = reqDow === 4 || reqDow === 5 || reqDow === 6 ? reqDow : 5;
  let cursor = todayIso > requestedCheckIn ? todayIso : requestedCheckIn;
  // avanzar hasta el próximo día-de-semana ancla (no arrancar en el pasado)
  while (cursor < todayIso) cursor = addDaysIso(cursor, 1);
  while (parts(cursor).dow !== anchorDow) cursor = addDaysIso(cursor, 1);

  const weekends: DateWindow[] = [];
  for (let w = 0; w < weekendHorizonWeeks && weekends.length < maxWeekends; w++) {
    const ci = addDaysIso(cursor, w * 7);
    if (ci === requestedCheckIn) continue; // esa semana es la pedida (ocupada)
    if (nearest && ci === nearest.checkIn) continue; // ya va como "más cercana"
    if (notPast(ci) && isFree(ci)) {
      weekends.push({ checkIn: ci, checkOut: addDaysIso(ci, nights), nights });
    }
  }

  return { nearest, weekends };
}

// ── Formato humano de una ventana (para el mensaje de WhatsApp) ───────────────

const WD_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const MON_EN = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Ventana → texto natural. es: "jueves 23 al sábado 25 de julio" · en:
 * "Thu Jul 23 – Sat Jul 25". Si cruza de mes, nombra el mes en ambos extremos.
 */
export function formatWindowHuman(
  w: { checkIn: string; checkOut: string },
  lang: Lang = "es",
): string {
  const a = parts(w.checkIn);
  const b = parts(w.checkOut);
  const sameMonth = a.m === b.m && a.y === b.y;

  if (lang === "en") {
    return sameMonth
      ? `${WD_EN[a.dow]} ${MON_EN[a.m - 1]} ${a.d} – ${WD_EN[b.dow]} ${b.d}`
      : `${WD_EN[a.dow]} ${MON_EN[a.m - 1]} ${a.d} – ${WD_EN[b.dow]} ${MON_EN[b.m - 1]} ${b.d}`;
  }
  return sameMonth
    ? `${WD_ES[a.dow]} ${a.d} al ${WD_ES[b.dow]} ${b.d} de ${MON_ES[a.m - 1]}`
    : `${WD_ES[a.dow]} ${a.d} de ${MON_ES[a.m - 1]} al ${WD_ES[b.dow]} ${b.d} de ${MON_ES[b.m - 1]}`;
}
