//
// date-parser.ts — Resolución DETERMINÍSTICA de fechas (sin LLM).
//
// Por qué existe: el LLM razona pésimo la matemática de fechas. Los bugs reales
// que motivaron esto (ver references/patrones-de-fallo.md):
//   - "17 de julio" estando en junio → el bot dijo "ya pasó" / lo movió a junio.
//   - "mañana" → el bot no sabía qué día era mañana.
//   - "4 adultos" → el bot lo confundió con "4 noches".
//
// Regla de oro de la industria: NUNCA hagas del LLM tu primer parser de fechas.
// El LLM entiende el lenguaje; el CÓDIGO resuelve los números. Acá el LLM solo
// aporta su ISO tentativo como fallback; este módulo tiene la ÚLTIMA palabra.
//
// Es PURO y relativo a un `today` que se le PASA (no lee el reloj) → 100% testeable.
// Su comportamiento está blindado por __tests__/date-parser.test.ts.
//
// Garantías (invariantes que el resto del flujo puede asumir):
//   G1. Nunca devuelve un check-in ANTERIOR a `today`.
//   G2. Nunca devuelve check-out <= check-in.
//   G3. Una fecha relativa/explícita en el mensaje ACTUAL gana sobre el ISO del LLM.
//   G4. Las NOCHES salen solo de "noches/días/semana", JAMÁS de "personas/adultos".
//

import { nightsBetween } from "./detectors";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de fecha (puros, UTC, sobre strings YYYY-MM-DD)
// ─────────────────────────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ¿Es un YYYY-MM-DD que además existe en el calendario (rechaza 2026-02-30)? */
export function isValidIso(iso: string | null | undefined): iso is string {
  if (!iso || !ISO_RE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** YYYY-MM-DD + n días (UTC, sin DST). */
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Día de la semana de un ISO: 0=domingo … 6=sábado. */
function dowOfIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function fromYMD(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function strip(text: string): string {
  // ̀-ͯ = marcas diacríticas combinantes (acentos, tildes).
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tablas de meses / días
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};
const MONTH_ALT = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";

// lunes=1 … domingo=0 (igual que getUTCDay)
const WEEKDAYS: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

/**
 * Resuelve el AÑO de una fecha día/mes sin año: la PRÓXIMA ocurrencia ≥ today.
 * "17 de julio" en 2026-06-15 → 2026-07-17 (este año, aún no pasa).
 * "5 de enero"  en 2026-06-15 → 2027-01-05 (enero ya pasó → el próximo).
 */
function resolveYearFor(day: number, month: number, today: string): string | null {
  const ty = Number(today.slice(0, 4));
  for (let y = ty; y <= ty + 1; y++) {
    const cand = fromYMD(y, month, day);
    if (isValidIso(cand) && cand >= today) return cand;
  }
  return null;
}

export interface ExtractedDates {
  checkIn: string | null;
  checkOut: string | null;
  /** Noches mencionadas EXPLÍCITAMENTE ("3 noches", "una semana"). null si no. */
  nights: number | null;
}

/**
 * Extrae fechas/noches del mensaje ACTUAL (no del historial). Determinístico.
 * Prioridad: rango con mes → fechas explícitas con mes → numéricas D/M →
 * relativas (mañana / día de semana / fin de semana). Las noches se extraen aparte.
 */
export function extractDatePhrases(text: string, today: string): ExtractedDates {
  const t = strip(text);
  let checkIn: string | null = null;
  let checkOut: string | null = null;

  // ── 1. Rango con mes: "del 17 al 19 de julio" / "del 17 de julio al 2 de agosto"
  const rangeRe = new RegExp(
    `\\bdel?\\s+(\\d{1,2})(?:\\s+de\\s+(${MONTH_ALT}))?\\s+al?\\s+(\\d{1,2})\\s+de\\s+(${MONTH_ALT})\\b`,
  );
  const rng = t.match(rangeRe);
  if (rng) {
    const d1 = Number(rng[1]);
    const m2 = MONTHS[rng[4]];
    const m1 = rng[2] ? MONTHS[rng[2]] : m2; // si no dice el mes del inicio, usa el del final
    const d2 = Number(rng[3]);
    const ci = resolveYearFor(d1, m1, today);
    if (ci) {
      checkIn = ci;
      // el check-out usa el mismo año base que el check-in (puede cruzar de año)
      const yBase = Number(ci.slice(0, 4));
      let co = fromYMD(yBase, m2, d2);
      if (isValidIso(co) && co <= ci) co = fromYMD(yBase + 1, m2, d2); // ej. dic→ene
      if (isValidIso(co)) checkOut = co;
    }
  }

  // ── 2. Fechas explícitas con mes: lista de días ("7,8 y 9 de agosto") o sueltas
  if (!checkIn) {
    // Lista de números pegados al mismo "de <mes>" ("7,8 y 9 de agosto",
    // "16,17 y 18 de julio") → son NOCHES consecutivas: check-in = el menor,
    // check-out = el día SIGUIENTE al mayor (misma convención que ya usa el LLM
    // para listas sin mes explícito, ej. "16,17 y 18" solo — caso real Jasmin/Villa B11).
    const listRe = new RegExp(`([\\d,\\sy]{1,20})\\bde\\s+(${MONTH_ALT})\\b`);
    const lm = t.match(listRe);
    const listNums = lm
      ? [...lm[1].matchAll(/\d{1,2}/g)].map((m) => Number(m[0])).filter((n) => n >= 1 && n <= 31)
      : [];

    if (listNums.length >= 2) {
      const month = MONTHS[lm![2]];
      const lo = Math.min(...listNums);
      const hi = Math.max(...listNums);
      const ci = resolveYearFor(lo, month, today);
      if (ci) {
        checkIn = ci;
        const co = addDaysIso(fromYMD(Number(ci.slice(0, 4)), month, hi), 1);
        if (isValidIso(co)) checkOut = co;
      }
    } else {
      // Fechas sueltas, cada una con su propio "de <mes>": "17 de julio", o dos
      // fechas distintas sin ser una lista ("17 de julio" ... "2 de agosto").
      const singleRe = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${MONTH_ALT})\\b`, "g");
      const found: string[] = [];
      for (const m of t.matchAll(singleRe)) {
        const iso = resolveYearFor(Number(m[1]), MONTHS[m[2]], today);
        if (iso) found.push(iso);
      }
      if (found.length >= 1) checkIn = found[0];
      if (found.length >= 2 && found[1] > found[0]) checkOut = found[1];
    }
  }

  // ── 3. Numérica D/M o D/M/Y: "17/07", "17-07-2026" (Honduras = día/mes)
  if (!checkIn) {
    const numRe = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g;
    const found: string[] = [];
    for (const m of t.matchAll(numRe)) {
      const day = Number(m[1]);
      const month = Number(m[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      let iso: string | null;
      if (m[3]) {
        const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
        const cand = fromYMD(yr, month, day);
        iso = isValidIso(cand) ? cand : null;
      } else {
        iso = resolveYearFor(day, month, today);
      }
      if (iso) found.push(iso);
    }
    if (found.length >= 1) checkIn = found[0];
    if (found.length >= 2 && found[1] > found[0]) checkOut = found[1];
  }

  // ── 4. Relativas (solo si no hubo fecha explícita) ──────────────────────────
  if (!checkIn) {
    if (/\bpasado\s+manana\b/.test(t)) {
      checkIn = addDaysIso(today, 2);
    } else if (/\bmanana\b/.test(t) && !/\b(la|por la|de la|en la|esta)\s+manana\b/.test(t)) {
      // "mañana" = hoy+1; se excluye el sentido "por la mañana" (horario, no fecha)
      checkIn = addDaysIso(today, 1);
    } else if (/\bhoy\b/.test(t)) {
      checkIn = today;
    } else if (/\b(este|el|esta|el proximo|la proxima)\s+(fin de semana|finde)\b/.test(t)) {
      // próximo viernes → domingo
      const fri = nextWeekday(today, 5);
      checkIn = fri;
      checkOut = addDaysIso(fri, 2);
    } else {
      // Día(s) de semana nombrados, con o sin número de día del mes pegado:
      // "el domingo" · "viernes 21" · "entrar el viernes y salir el domingo" ·
      // "viernes 21, sábado y domingo 23" (caso real Jasmin/Villa B11, 10-jul-2026:
      // antes solo tomaba el PRIMER día mencionado e ignoraba el resto, dejando el
      // check-out colgado — se resolvía con un check-out sobrante de otro turno).
      const wdRe = new RegExp(`\\b(${Object.keys(WEEKDAYS).join("|")})\\b(?:\\s+(\\d{1,2}))?`, "g");
      const wds = [...t.matchAll(wdRe)];
      if (wds.length === 1) {
        const [, name, dayStr] = wds[0];
        checkIn = dayStr
          ? resolveWeekdayWithDay(Number(dayStr), WEEKDAYS[name], today)
          : nextWeekday(today, WEEKDAYS[name]);
      } else if (wds.length >= 2) {
        const first = wds[0];
        const last = wds[wds.length - 1];
        const ci = first[2]
          ? resolveWeekdayWithDay(Number(first[2]), WEEKDAYS[first[1]], today)
          : nextWeekday(today, WEEKDAYS[first[1]]);
        if (ci) {
          checkIn = ci;
          checkOut = last[2]
            ? resolveWeekdayWithDay(Number(last[2]), WEEKDAYS[last[1]], today)
            : nextWeekday(ci, WEEKDAYS[last[1]]); // relativo al check-in, no a hoy
        }
      }
    }
  }

  return { checkIn, checkOut, nights: extractNights(t) };
}

/** Próxima ocurrencia (estricta) de un día de la semana desde `today`. */
function nextWeekday(today: string, targetDow: number): string {
  const cur = dowOfIso(today);
  let delta = (targetDow - cur + 7) % 7;
  if (delta === 0) delta = 7; // "el domingo" siendo hoy domingo = el próximo
  return addDaysIso(today, delta);
}

/**
 * "viernes 21" — un día del mes SIN mes explícito es ambiguo (¿este mes o el que
 * viene?). Se resuelve con el propio nombre del día de semana como pista: busca
 * el próximo mes donde ese número de día caiga REALMENTE en ese día de semana
 * (hasta 13 meses adelante). Caso real (Jasmin/Villa B11, 10-jul-2026): "viernes
 * 21" con today=10-jul — el 21 de julio es MARTES, así que se descarta y el 21
 * de agosto (que SÍ es viernes) gana.
 */
function resolveWeekdayWithDay(day: number, targetDow: number, today: string): string | null {
  const [ty, tm] = today.slice(0, 7).split("-").map(Number);
  for (let k = 0; k <= 13; k++) {
    const m0 = tm - 1 + k;
    const y = ty + Math.floor(m0 / 12);
    const m = (m0 % 12) + 1;
    const cand = fromYMD(y, m, day);
    if (isValidIso(cand) && cand >= today && dowOfIso(cand) === targetDow) return cand;
  }
  return null;
}

/**
 * Noches mencionadas EXPLÍCITAMENTE. G4: nunca de personas/adultos/huéspedes.
 * "una noche"→1 · "3 noches"→3 · "4 días"→4 · "una semana"→7 · "2 semanas"→14.
 */
export function extractNights(textOrStripped: string): number | null {
  const t = strip(textOrStripped); // idempotente si ya viene normalizado
  if (/\buna\s+noche\b/.test(t)) return 1;
  if (/\buna\s+semana\b/.test(t)) return 7;
  let m = t.match(/\b(\d{1,2})\s+noches?\b/);
  if (m) return Number(m[1]);
  m = t.match(/\b(\d{1,2})\s+semanas?\b/);
  if (m) return Number(m[1]) * 7;
  m = t.match(/\b(\d{1,2})\s+dias?\b/);
  if (m) return Number(m[1]);
  return null;
}

/** Lleva un ISO al futuro si quedó en el pasado, subiendo el año (máx +2). null si no se puede. */
function ensureFuture(iso: string | null, today: string): string | null {
  if (!isValidIso(iso)) return null;
  if (iso >= today) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  for (let k = 1; k <= 2; k++) {
    const cand = fromYMD(y + k, m, d);
    if (isValidIso(cand) && cand >= today) return cand;
  }
  return null; // estrictamente pasada e irrecuperable → mejor null (el bot pregunta) que cotizar el pasado
}

export interface ResolvedDates {
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  /** true si el parser cambió algo respecto del ISO que traía el LLM. Para métricas. */
  corrected: boolean;
}

/**
 * Punto de entrada. Toma el mensaje actual + el ISO tentativo del LLM (ya mergeado
 * con lo previo) + hoy, y devuelve fechas corregidas/validadas con las garantías G1-G4.
 */
export function resolveDates(
  text: string,
  llmCheckIn: string | null,
  llmCheckOut: string | null,
  today: string,
): ResolvedDates {
  const ex = extractDatePhrases(text, today);

  let checkIn = ex.checkIn ?? llmCheckIn ?? null;
  let checkOut = ex.checkOut ?? null;

  // noches explícitas → derivar salida si aún no la tenemos
  if (!checkOut && ex.nights != null && checkIn) {
    checkOut = addDaysIso(checkIn, ex.nights);
  }
  if (!checkOut) checkOut = llmCheckOut ?? null;

  // G1: check-in nunca en el pasado
  checkIn = ensureFuture(checkIn, today);

  // G2: check-out > check-in. Si quedó mal ordenado, recomputar desde noches o descartar.
  if (checkIn && checkOut) {
    if (!isValidIso(checkOut) || checkOut <= checkIn) {
      checkOut = ex.nights != null ? addDaysIso(checkIn, ex.nights) : null;
    }
  } else if (checkOut && !isValidIso(checkOut)) {
    checkOut = null;
  }
  // sin check-in no puede haber check-out colgando
  if (!checkIn) checkOut = null;

  const nights = checkIn && checkOut ? nightsBetween(checkIn, checkOut) : null;
  const corrected = checkIn !== llmCheckIn || checkOut !== llmCheckOut;

  return { checkIn, checkOut, nights, corrected };
}
