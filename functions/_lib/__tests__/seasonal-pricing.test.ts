import { describe, it, expect } from "vitest";
import {
  stayNights,
  computeStayHNL,
  requiredMinNights,
  staysTouchesSeason,
  SEASONAL_WINDOWS,
} from "../seasonal-pricing";

//
// Semana Morazánica 2026 (pedido de César, 2026-07-25): noches del 2-oct al
// 10-oct inclusive (check-out hasta el 11). Estos tests fijan los BORDES de la
// ventana y la mezcla noche a noche — el terreno clásico de los off-by-one.
//

describe("stayNights — noches de una estadía [checkIn, checkOut)", () => {
  it("2 noches: la noche del check-out NO se duerme", () => {
    expect(stayNights("2026-10-02", "2026-10-04")).toEqual(["2026-10-02", "2026-10-03"]);
  });
  it("rangos inválidos → []", () => {
    expect(stayNights("2026-10-04", "2026-10-02")).toEqual([]);
    expect(stayNights("2026-10-02", "2026-10-02")).toEqual([]);
    expect(stayNights("basura", "2026-10-02")).toEqual([]);
  });
});

describe("bordes de la ventana morazánica (2026-10-02 → 2026-10-10)", () => {
  it("la noche del 1-oct queda FUERA: estadía 1→2 oct no toca la temporada", () => {
    expect(staysTouchesSeason("casa-brisa", "2026-10-01", "2026-10-02")).toBe(false);
  });
  it("la noche del 2-oct es la PRIMERA adentro", () => {
    expect(staysTouchesSeason("casa-brisa", "2026-10-02", "2026-10-03")).toBe(true);
  });
  it("la noche del 10-oct es la ÚLTIMA adentro (check-out 11-oct todavía es temporada)", () => {
    expect(staysTouchesSeason("casa-brisa", "2026-10-10", "2026-10-11")).toBe(true);
  });
  it("estadía 11→13 oct queda FUERA (noches 11 y 12)", () => {
    expect(staysTouchesSeason("casa-brisa", "2026-10-11", "2026-10-13")).toBe(false);
  });
});

describe("computeStayHNL — mezcla noche a noche", () => {
  it("estadía mixta (30-sep → 3-oct, Casa Brisa): 2 noches base + 1 de temporada", () => {
    const r = computeStayHNL("casa-brisa", "2026-09-30", "2026-10-03", 2500);
    expect(r.baseNights).toBe(2);       // 30-sep, 1-oct
    expect(r.seasonNights).toBe(1);     // 2-oct
    expect(r.seasonRateHNL).toBe(3900);
    expect(r.seasonName).toBe("Semana Morazánica");
    expect(r.nightsTotalHNL).toBe(2 * 2500 + 3900); // 8,900
  });
  it("estadía completa en temporada (Centro Morazán 2→5 oct): 3 noches × 3,000", () => {
    const r = computeStayHNL("centro-morazan", "2026-10-02", "2026-10-05", 2100);
    expect(r.baseNights).toBe(0);
    expect(r.seasonNights).toBe(3);
    expect(r.nightsTotalHNL).toBe(9000);
  });
  it("slug SIN tarifa de temporada (La Florida): todo a base, sin seasonName", () => {
    const r = computeStayHNL("la-florida", "2026-10-02", "2026-10-05", 650);
    expect(r.seasonNights).toBe(0);
    expect(r.seasonName).toBeNull();
    expect(r.nightsTotalHNL).toBe(3 * 650);
  });
});

describe("requiredMinNights — mínimos por propiedad confirmados por César", () => {
  it("Centro Morazán: mínimo 3", () => {
    expect(requiredMinNights("centro-morazan", "2026-10-02", "2026-10-04")).toEqual({
      minNights: 3,
      seasonName: "Semana Morazánica",
    });
  });
  it("Casa Brisa / Casa Marea / Villa B11: mínimo 4", () => {
    for (const slug of ["casa-brisa", "casa-marea", "villa-b11-palma-real"]) {
      expect(requiredMinNights(slug, "2026-10-03", "2026-10-05")?.minNights).toBe(4);
    }
  });
  it("Las Gemelas (combo): 7,800/noche, mínimo 4", () => {
    expect(requiredMinNights("las-gemelas-tela", "2026-10-02", "2026-10-06")?.minNights).toBe(4);
    const r = computeStayHNL("las-gemelas-tela", "2026-10-02", "2026-10-06", 5000);
    expect(r.nightsTotalHNL).toBe(4 * 7800);
  });
  it("fuera de la ventana o sin tarifa → null (sin restricción)", () => {
    expect(requiredMinNights("casa-brisa", "2026-08-15", "2026-08-17")).toBeNull();
    expect(requiredMinNights("la-florida", "2026-10-02", "2026-10-05")).toBeNull();
  });
});

describe("sanidad del dato de la ventana", () => {
  it("la morazánica 2026 existe con las 5 propiedades y los montos confirmados", () => {
    const w = SEASONAL_WINDOWS.find((x) => x.name === "Semana Morazánica")!;
    expect(w.startNight).toBe("2026-10-02");
    expect(w.endNight).toBe("2026-10-10");
    expect(w.rates["centro-morazan"]).toEqual({ priceHNL: 3000, minNights: 3 });
    expect(w.rates["casa-brisa"]).toEqual({ priceHNL: 3900, minNights: 4 });
    expect(w.rates["casa-marea"]).toEqual({ priceHNL: 3900, minNights: 4 });
    expect(w.rates["villa-b11-palma-real"]).toEqual({ priceHNL: 3900, minNights: 4 });
    expect(w.rates["las-gemelas-tela"]).toEqual({ priceHNL: 7800, minNights: 4 });
  });
});
