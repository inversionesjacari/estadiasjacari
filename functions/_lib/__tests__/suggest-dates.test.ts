import { describe, it, expect } from "vitest";
import { findAlternativeDates, formatWindowHuman } from "../suggest-dates";
import { addDaysIso } from "../date-parser";
import { T } from "../i18n";

//
// CHAT REAL — Cliente +504 9872-6411 (Villa B11 — Palma Real). Pidió jueves 16 →
// sábado 18 jul (2 noches) para una familia de 5. La villa estaba OCUPADA y el bot
// solo dijo "no disponible del 16 al 18 jul 😔 ¿querés cambiar las fechas o probar
// otra propiedad?" y se quedó esperando → lead frío.
//
// César: "si buscan 2 noches en un fin de semana, el bot debe (1) decir las fechas
// disponibles CERCA de lo que necesitan y (2) si no, compartir OTROS fines de semana
// disponibles". Eso es matemática de calendario → CÓDIGO (findAlternativeDates), no
// prompt. Estos tests son el blindaje: el motor lee el MISMO set de fechas ocupadas
// (getBlockedDates) con el que el bot ya decide "no disponible".
//

const TODAY = "2026-07-11"; // sábado
const REQ_IN = "2026-07-16"; // jueves (lo que el cliente pidió)
const REQ_OUT = "2026-07-18"; // 2 noches: 16 y 17

/** Set de fechas ocupadas a partir de una noche inicial + cuántas noches seguidas. */
function blockedRange(startIso: string, nights: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < nights; i++) out.push(addDaysIso(startIso, i));
  return out;
}

describe("findAlternativeDates — motor de sugerencia (Villa B11, 16–18 jul OCUPADO)", () => {
  it("propone ventana MÁS CERCANA + otros fines de semana cuando las fechas están ocupadas", () => {
    const set = new Set(["2026-07-16", "2026-07-17"]); // solo las 2 noches pedidas
    const alt = findAlternativeDates(set, REQ_IN, REQ_OUT, TODAY);

    // nearest: existe, 2 noches, totalmente libre, no es lo pedido, no en el pasado
    expect(alt.nearest).not.toBeNull();
    expect(alt.nearest!.nights).toBe(2);
    expect(alt.nearest!.checkIn >= TODAY).toBe(true);
    expect(alt.nearest!.checkIn).not.toBe(REQ_IN);
    for (let i = 0; i < 2; i++) expect(set.has(addDaysIso(alt.nearest!.checkIn, i))).toBe(false);

    // weekends: al menos uno, mismo día de semana (jueves) que lo pedido, libres y futuros
    expect(alt.weekends.length).toBeGreaterThanOrEqual(1);
    const reqDow = new Date(REQ_IN + "T00:00:00Z").getUTCDay();
    for (const w of alt.weekends) {
      expect(w.checkIn > REQ_IN).toBe(true);
      expect(new Date(w.checkIn + "T00:00:00Z").getUTCDay()).toBe(reqDow);
      for (let i = 0; i < 2; i++) expect(set.has(addDaysIso(w.checkIn, i))).toBe(false);
    }
  });

  it("con solo las noches pedidas ocupadas → nearest = sábado 18, findes = jueves 23 y 30", () => {
    const set = new Set(["2026-07-16", "2026-07-17"]);
    const alt = findAlternativeDates(set, REQ_IN, REQ_OUT, TODAY);
    expect(alt.nearest!.checkIn).toBe("2026-07-18");
    expect(alt.weekends.map((w) => w.checkIn)).toEqual(["2026-07-23", "2026-07-30"]);
  });

  it("si adelante está TODO ocupado, mira hacia atrás (nearest antes de lo pedido)", () => {
    const set = new Set(blockedRange("2026-07-16", 9)); // 16..24 ocupados
    const alt = findAlternativeDates(set, REQ_IN, REQ_OUT, TODAY);
    // 14 y 15 quedan libres (check-out 16 no cuenta) → 2 días antes de lo pedido
    expect(alt.nearest!.checkIn).toBe("2026-07-14");
  });

  it("nunca propone fechas en el pasado", () => {
    const alt = findAlternativeDates(new Set([TODAY, "2026-07-12"]), TODAY, "2026-07-13", TODAY);
    expect(alt.nearest!.checkIn >= TODAY).toBe(true);
    for (const w of alt.weekends) expect(w.checkIn >= TODAY).toBe(true);
  });

  it("sin ninguna ventana libre en el horizonte → nearest null y weekends vacío (fallback)", () => {
    const set = new Set(blockedRange("2026-06-01", 200)); // jun–dic ocupado
    const alt = findAlternativeDates(set, REQ_IN, REQ_OUT, TODAY, {
      horizonDays: 5,
      weekendHorizonWeeks: 3,
    });
    expect(alt.nearest).toBeNull();
    expect(alt.weekends).toEqual([]);
  });
});

describe("formatWindowHuman — fecha legible es/en", () => {
  it("es · mismo mes", () => {
    expect(formatWindowHuman({ checkIn: "2026-07-23", checkOut: "2026-07-25" }, "es")).toBe(
      "jueves 23 al sábado 25 de julio",
    );
  });
  it("es · cruza de mes", () => {
    expect(formatWindowHuman({ checkIn: "2026-07-30", checkOut: "2026-08-01" }, "es")).toBe(
      "jueves 30 de julio al sábado 1 de agosto",
    );
  });
  it("en · mismo mes", () => {
    expect(formatWindowHuman({ checkIn: "2026-07-23", checkOut: "2026-07-25" }, "en")).toBe(
      "Thu Jul 23 – Sat 25",
    );
  });
  it("en · cruza de mes", () => {
    expect(formatWindowHuman({ checkIn: "2026-07-30", checkOut: "2026-08-01" }, "en")).toBe(
      "Thu Jul 30 – Sat Aug 1",
    );
  });
});

describe("T.unavailableWithAlternatives — mensaje que PROPONE (no solo 'no disponible')", () => {
  const alt = findAlternativeDates(new Set(["2026-07-16", "2026-07-17"]), REQ_IN, REQ_OUT, TODAY);

  it("nombra la propiedad, incluye fechas concretas y NO dice 'no puedo' / 'no disponible' a secas", () => {
    for (const l of ["es", "en"] as const) {
      const msg = T.unavailableWithAlternatives(l, "Villa B11 — Palma Real", alt, true);
      expect(msg).toContain("Villa B11 — Palma Real");
      // propone al menos la ventana más cercana, formateada legible
      expect(msg).toContain(formatWindowHuman(alt.nearest!, l));
      // playa → 🌴
      expect(msg).toContain("🌴");
      // nunca el callejón sin salida del chat viejo
      expect(msg.toLowerCase()).not.toContain("no puedo");
      expect(msg.toLowerCase()).not.toContain("can't");
    }
  });

  it("Tegucigalpa (no playa) → sin 🌴", () => {
    const msg = T.unavailableWithAlternatives("es", "Centro Morazán", alt, false);
    expect(msg).not.toContain("🌴");
  });

  it("fallback sin alternativas: mensaje genérico válido, nunca vacío", () => {
    const msg = T.unavailableWithAlternatives("es", "Villa B11 — Palma Real", { nearest: null, weekends: [] }, true);
    expect(msg).toContain("Villa B11 — Palma Real");
    expect(msg.length).toBeGreaterThan(20);
  });
});
