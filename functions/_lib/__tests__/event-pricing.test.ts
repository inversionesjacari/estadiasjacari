import { describe, it, expect } from "vitest";
import {
  computeEventPrice,
  eventBaseForPax,
  eventDesdeHnl,
  formatEventHnl,
  EVENT_DESDE_BY_TYPE,
  EVENT_PRICE_FLOOR_HNL,
  EVENT_CAPACITY_MAX,
} from "../event-pricing";

// La rate card del venue de eventos de Valle de Ángeles. La ESPECIFICACIÓN viva es
// el doc `05_automatizacion/13_venue_valle_de_angeles_estructura_cobro.md`: los 7
// ejemplos de §2.3 son la fuente de verdad. Si alguien mueve un multiplicador o el
// redondeo, estos tests gritan antes de que un lead vea un número equivocado.

describe("computeEventPrice — los 7 ejemplos verificados del doc §2.3", () => {
  const cases: Array<[string, Parameters<typeof computeEventPrice>[0], number]> = [
    ["Boda 80 · Sáb · Alta", { pax: 80, type: "boda", day: "sabado", season: "alta" }, 43000],
    ["Boda 100 · Sáb · Alta", { pax: 100, type: "boda", day: "sabado", season: "alta" }, 50800],
    ["Boda 80 · Sáb · Estándar", { pax: 80, type: "boda", day: "sabado", season: "estandar" }, 37400],
    ["XV 60 · Sáb · Estándar", { pax: 60, type: "xv", day: "sabado", season: "estandar" }, 24300],
    ["Social 40 · Vie · Estándar", { pax: 40, type: "social", day: "viernes", season: "estandar" }, 12600],
    ["Cumpleaños 20 · Sáb · Estándar", { pax: 20, type: "social", day: "sabado", season: "estandar" }, 10000],
    ["Corporativo 30 · Entre sem · Estándar", { pax: 30, type: "corporativo", day: "entre_semana", season: "estandar" }, 9500],
  ];
  for (const [name, args, expected] of cases) {
    it(name, () => {
      expect(computeEventPrice(args)).toBe(expected);
    });
  }
});

describe("computeEventPrice — piso duro, redondeo y defaults", () => {
  it("nunca cobra menos del piso L9,000", () => {
    // Corporativo chico entre semana en baja: la fórmula da ~6,800 → sube al piso.
    expect(computeEventPrice({ pax: 20, type: "corporativo", day: "entre_semana", season: "baja" })).toBe(
      EVENT_PRICE_FLOOR_HNL,
    );
    expect(computeEventPrice({ pax: 20, type: "corporativo", day: "entre_semana", season: "baja" })).toBeGreaterThanOrEqual(
      EVENT_PRICE_FLOOR_HNL,
    );
  });

  it("redondea al múltiplo de 100 más cercano", () => {
    // 22,000×1.7×1.0×1.15 = 43,010 → 43,000
    expect(computeEventPrice({ pax: 80, type: "boda", day: "sabado", season: "alta" })! % 100).toBe(0);
    // 26,000×1.7×1.0×1.15 = 50,830 → 50,800
    expect(computeEventPrice({ pax: 100, type: "boda", day: "sabado", season: "alta" })).toBe(50800);
  });

  it("day/season por defecto = sábado · estándar (la referencia de la tabla base)", () => {
    expect(computeEventPrice({ pax: 60, type: "xv" })).toBe(
      computeEventPrice({ pax: 60, type: "xv", day: "sabado", season: "estandar" }),
    );
    // XV 60 sáb estándar = 18,000×1.35 = 24,300
    expect(computeEventPrice({ pax: 60, type: "xv" })).toBe(24300);
  });
});

describe("eventBaseForPax — bandas y límites", () => {
  it("respeta los topes de banda", () => {
    expect(eventBaseForPax(1)).toBe(10000);
    expect(eventBaseForPax(20)).toBe(10000);
    expect(eventBaseForPax(21)).toBe(14000);
    expect(eventBaseForPax(40)).toBe(14000);
    expect(eventBaseForPax(41)).toBe(18000);
    expect(eventBaseForPax(60)).toBe(18000);
    expect(eventBaseForPax(61)).toBe(22000);
    expect(eventBaseForPax(80)).toBe(22000);
    expect(eventBaseForPax(81)).toBe(26000);
    expect(eventBaseForPax(100)).toBe(26000);
  });

  it("más de 100 pax → null (fuera de la rate card → derivar al equipo)", () => {
    expect(eventBaseForPax(101)).toBeNull();
    expect(eventBaseForPax(500)).toBeNull();
    expect(computeEventPrice({ pax: 150, type: "boda", day: "sabado", season: "alta" })).toBeNull();
  });

  it("pax inválido → null", () => {
    expect(eventBaseForPax(0)).toBeNull();
    expect(eventBaseForPax(-5)).toBeNull();
    expect(eventBaseForPax(NaN)).toBeNull();
  });
});

describe("eventDesdeHnl — el 'desde' que muestra el bot", () => {
  it("los 'desde' editoriales del doc §2.4 salen de la fórmula (pax repr · sábado · baja)", () => {
    // boda: 80 pax · sáb · baja = 22,000×1.7×1.0×0.85 = 31,790 → 31,800
    expect(computeEventPrice({ pax: 80, type: "boda", day: "sabado", season: "baja" })).toBe(31800);
    expect(EVENT_DESDE_BY_TYPE.boda).toBe(31800);
    // xv: 60 pax · sáb · baja = 18,000×1.35×1.0×0.85 = 20,655 → 20,700
    expect(computeEventPrice({ pax: 60, type: "xv", day: "sabado", season: "baja" })).toBe(20700);
    expect(EVENT_DESDE_BY_TYPE.xv).toBe(20700);
    // corp/social: piso duro
    expect(EVENT_DESDE_BY_TYPE.corporativo).toBe(9000);
    expect(EVENT_DESDE_BY_TYPE.social).toBe(9000);
  });

  it("sin pax → el 'desde' editorial por tipo", () => {
    expect(eventDesdeHnl("boda")).toBe(31800);
    expect(eventDesdeHnl("xv")).toBe(20700);
    expect(eventDesdeHnl("corporativo")).toBe(9000);
    expect(eventDesdeHnl("social")).toBe(9000);
    expect(eventDesdeHnl("boda", null)).toBe(31800);
  });

  it("con pax → el 'desde' tallado a ese tamaño (sábado · baja), un piso honesto", () => {
    // una boda chica cuesta menos que el editorial de 80 pax → no anclamos de más
    expect(eventDesdeHnl("boda", 20)).toBe(
      computeEventPrice({ pax: 20, type: "boda", day: "sabado", season: "baja" }),
    );
    expect(eventDesdeHnl("boda", 20)).toBeLessThan(EVENT_DESDE_BY_TYPE.boda);
    // una boda de 80 = el editorial
    expect(eventDesdeHnl("boda", 80)).toBe(31800);
    // nunca por debajo del piso
    expect(eventDesdeHnl("social", 20)).toBeGreaterThanOrEqual(EVENT_PRICE_FLOOR_HNL);
  });

  it("pax > 100 → cae al editorial por tipo (no revienta; el handler escala igual)", () => {
    expect(eventDesdeHnl("boda", 150)).toBe(EVENT_DESDE_BY_TYPE.boda);
    expect(eventDesdeHnl("boda", EVENT_CAPACITY_MAX + 1)).toBe(EVENT_DESDE_BY_TYPE.boda);
  });
});

describe("formatEventHnl", () => {
  it("formatea al estilo del bot (L. + separador de miles)", () => {
    expect(formatEventHnl(31800)).toBe(`L.${(31800).toLocaleString("es-HN")}`);
    expect(formatEventHnl(9000)).toContain("L.");
    expect(formatEventHnl(9000)).toContain("9");
  });
});
