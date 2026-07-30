import { describe, it, expect } from "vitest";
import {
  buildQuote,
  formatQuoteMessage,
  computeDayPassHNL,
  addDayPass,
  applyVillaB11PackagePrice,
  VILLA_B11_PACKAGE_TOTAL_HNL,
  type QuoteOutput,
} from "../quote-builder";

// 2024-01-01 fue LUNES (verificado) → 2024-01-05 viernes, 2024-01-07 domingo.
const WEEKDAY_STAY = { checkIn: "2024-01-01", checkOut: "2024-01-03" }; // lun-mar
const WEEKEND_STAY = { checkIn: "2024-01-05", checkOut: "2024-01-07" }; // vie-dom

function baseQuote(overrides: Partial<QuoteOutput> = {}): QuoteOutput {
  return {
    available: true,
    nights: 2,
    pricePerNightHNL: 2500,
    cleaningFeeHNL: 350,
    totalHNL: 5350,
    depositHNL: 2675,
    balanceHNL: 2675,
    pricePerNightUSD: 90,
    cleaningFeeUSD: 14,
    totalUSD: 194,
    depositUSD: 97,
    balanceUSD: 97,
    propertyName: "Casa Marea",
    city: "Tela",
    capacity: 6,
    exceedsCapacity: false,
    sharedBeds: false,
    ...overrides,
  };
}

describe("computeDayPassHNL — Friends Trip (día pass Honduras Shores Plantation)", () => {
  it("entre semana: adulto L.250, niño L.150 (caso real Karen López usa fin de semana, este es el otro extremo)", () => {
    const r = computeDayPassHNL({ adults: 2, children: 2, ...WEEKDAY_STAY });
    expect(r.isWeekend).toBe(false);
    expect(r.hnl).toBe(2 * 250 + 2 * 150); // 800
  });
  it("fin de semana (viernes a domingo): adulto L.350, niño L.150 — caso real Karen López '4 adultos 2 niños'", () => {
    const r = computeDayPassHNL({ adults: 4, children: 2, ...WEEKEND_STAY });
    expect(r.isWeekend).toBe(true);
    expect(r.hnl).toBe(4 * 350 + 2 * 150); // 1,700
  });
  it("sin niños", () => {
    const r = computeDayPassHNL({ adults: 3, children: 0, ...WEEKDAY_STAY });
    expect(r.hnl).toBe(3 * 250);
  });
});

describe("addDayPass — suma el day pass a una cotización YA verificada", () => {
  it("total/depósito/saldo quedan INCLUSIVE del day pass (fin de semana, 4 adultos + 2 niños)", () => {
    const q = addDayPass(baseQuote(), { adults: 4, children: 2, ...WEEKEND_STAY });
    expect(q.dayPassHNL).toBe(1700);
    expect(q.dayPassIsWeekend).toBe(true);
    expect(q.totalHNL).toBe(5350 + 1700); // 7,050
    expect(q.depositHNL + q.balanceHNL).toBe(q.totalHNL);
    expect(q.totalUSD).toBeGreaterThan(194); // el day pass también se refleja en USD (PayPal cobra en USD)
    expect(q.depositUSD + q.balanceUSD).toBe(q.totalUSD);
  });
  it("una cotización NO disponible no se toca (nada que sumarle)", () => {
    const q = addDayPass(baseQuote({ available: false }), { adults: 4, children: 2, ...WEEKEND_STAY });
    expect(q.dayPassHNL).toBeUndefined();
    expect(q.totalHNL).toBe(5350);
  });
});

describe("applyVillaB11PackagePrice — Family pack / Love Trip (precio fijo L.5,400)", () => {
  it("estadía de EXACTAMENTE 2 noches → precio fijo, no importa cuántos huéspedes", () => {
    const q = applyVillaB11PackagePrice(baseQuote({ nights: 2, propertyName: "Villa B11 — Palma Real", city: "La Ceiba" }));
    expect(q.totalHNL).toBe(VILLA_B11_PACKAGE_TOTAL_HNL);
    expect(q.depositHNL + q.balanceHNL).toBe(q.totalHNL);
  });
  it("otra duración (no 2 noches) → NO aplica el precio fijo del paquete", () => {
    const q = applyVillaB11PackagePrice(baseQuote({ nights: 3, totalHNL: 7850 }));
    expect(q.totalHNL).toBe(7850);
  });
});

// GEMELAS-XBLOCK (13-jul-2026): el chequeo de conflicto D1 de buildQuote filtraba
// por slug EXACTO → una reserva de las-gemelas-tela no tumbaba la cotización de
// casa-marea (mismas fechas) ni al revés. Estos tests fijan la expansión del combo.
function makeConflictDb(cnt: number) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return { async first() { return { cnt }; } };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("buildQuote — cruce del combo Las Gemelas en el conflicto D1", () => {
  const stay = { checkIn: "2026-08-15", checkOut: "2026-08-17" };

  it("cotizar las-gemelas-tela consulta también casa-brisa y casa-marea; conflicto → no disponible", async () => {
    const { db, calls } = makeConflictDb(1); // hay una reserva que pisa (p.ej. casa-marea sola)
    const q = await buildQuote({ property: "las-gemelas-tela", guests: 8, ...stay }, db);
    expect(q).not.toBeNull();
    expect(q!.available).toBe(false);
    expect(calls[0].sql).toContain("property_slug IN (?, ?, ?)");
    expect(calls[0].binds).toContain("casa-brisa");
    expect(calls[0].binds).toContain("casa-marea");
  });

  it("cotizar casa-marea consulta también el combo; reserva del combo → no disponible", async () => {
    const { db, calls } = makeConflictDb(1);
    const q = await buildQuote({ property: "casa-marea", guests: 4, ...stay }, db);
    expect(q!.available).toBe(false);
    expect(calls[0].binds).toContain("las-gemelas-tela");
  });

  it("cotizar casa-brisa NO consulta casa-marea (brisa no bloquea marea); sin conflicto → disponible", async () => {
    const { db, calls } = makeConflictDb(0);
    const q = await buildQuote({ property: "casa-brisa", guests: 4, ...stay }, db);
    expect(q!.available).toBe(true);
    expect(calls[0].binds).toContain("las-gemelas-tela");
    expect(calls[0].binds).not.toContain("casa-marea");
  });
});

//
// SEMANA MORAZÁNICA (pedido de César, 2026-07-25): tarifa especial + estadía
// mínima, precio MIXTO noche a noche. Estos tests fijan la integración completa
// en buildQuote/formatQuoteMessage — camino de plata, cero tolerancia a drift.
//
describe("buildQuote — Semana Morazánica (2-11 oct 2026)", () => {
  it("estadía completa en ventana (Centro Morazán 2→5 oct): 3×3,000 + limpieza, mínimo 3 CUMPLIDO", async () => {
    const { db } = makeConflictDb(0);
    const q = await buildQuote({ property: "centro-morazan", guests: 4, checkIn: "2026-10-02", checkOut: "2026-10-05" }, db);
    expect(q!.available).toBe(true);
    expect(q!.totalHNL).toBe(3 * 3000 + 400); // 9,400
    expect(q!.pricePerNightHNL).toBe(3000);   // toda la estadía en temporada → el desglose simple usa la tarifa especial
    expect(q!.seasonName).toBe("Semana Morazánica");
    // USD proporcional al TC implícito de la propiedad (2100 HNL = 80 USD)
    expect(q!.pricePerNightUSD).toBe(Math.round(3000 * (80 / 2100))); // 114
    expect(q!.totalUSD).toBe(3 * 114 + 16); // 358
  });

  it("VIOLA el mínimo (Centro Morazán 2→4 oct, 2 noches < 3): no disponible + minNightsRequired", async () => {
    const { db } = makeConflictDb(0);
    const q = await buildQuote({ property: "centro-morazan", guests: 4, checkIn: "2026-10-02", checkOut: "2026-10-04" }, db);
    expect(q!.available).toBe(false);
    expect(q!.minNightsRequired).toBe(3);
    expect(q!.exceedsCapacity).toBe(false);
    const msg = formatQuoteMessage(q!, { property: "centro-morazan", guests: 4, checkIn: "2026-10-02", checkOut: "2026-10-04" });
    expect(msg).toContain("Semana Morazánica");
    expect(msg).toContain("mínima de 3 noches");
    expect(msg).not.toContain("no está disponible"); // NO es el mensaje de fechas ocupadas
  });

  it("estadía MIXTA (Casa Brisa 30-sep→4-oct): 2 base + 2 temporada, mínimo 4 cumplido, desglose de dos líneas", async () => {
    const { db } = makeConflictDb(0);
    const input = { property: "casa-brisa" as const, guests: 4, checkIn: "2026-09-30", checkOut: "2026-10-04" };
    const q = await buildQuote(input, db);
    expect(q!.available).toBe(true);
    expect(q!.baseNights).toBe(2);
    expect(q!.seasonNights).toBe(2);
    expect(q!.totalHNL).toBe(2 * 2500 + 2 * 3900 + 350); // 13,150
    expect(q!.pricePerNightHNL).toBe(2500); // mixta → el campo simple queda en base; el mensaje desglosa
    const msg = formatQuoteMessage(q!, input);
    expect(msg).toContain("2 noches × HNL 2,500");
    expect(msg).toContain("2 noches × HNL 3,900 (Semana Morazánica)");
    expect(msg).toContain("*Total: HNL 13,150*");
  });

  it("mixta que VIOLA el mínimo (Casa Brisa 1→3 oct: 2 noches, toca la ventana) → rechazo con mínimo 4", async () => {
    const { db } = makeConflictDb(0);
    const q = await buildQuote({ property: "casa-brisa", guests: 4, checkIn: "2026-10-01", checkOut: "2026-10-03" }, db);
    expect(q!.available).toBe(false);
    expect(q!.minNightsRequired).toBe(4);
  });

  it("Las Gemelas 2→6 oct: 4×7,800 + 700, disponible", async () => {
    const { db } = makeConflictDb(0);
    const q = await buildQuote({ property: "las-gemelas-tela", guests: 10, checkIn: "2026-10-02", checkOut: "2026-10-06" }, db);
    expect(q!.available).toBe(true);
    expect(q!.totalHNL).toBe(4 * 7800 + 700); // 31,900
  });

  it("propiedad SIN temporada (La Florida 2→4 oct): tarifa normal, sin mínimo", async () => {
    const { db } = makeConflictDb(0);
    const q = await buildQuote({ property: "la-florida", guests: 2, checkIn: "2026-10-02", checkOut: "2026-10-04" }, db);
    expect(q!.available).toBe(true);
    expect(q!.totalHNL).toBe(2 * 650 + 350);
    expect(q!.minNightsRequired).toBeUndefined();
    expect(q!.seasonName).toBeNull();
  });

  it("fechas OCUPADAS + mínimo violado → el mensaje de ocupado GANA (minNightsRequired ausente)", async () => {
    const { db } = makeConflictDb(1); // conflicto en D1
    const q = await buildQuote({ property: "centro-morazan", guests: 4, checkIn: "2026-10-02", checkOut: "2026-10-04" }, db);
    expect(q!.available).toBe(false);
    expect(q!.minNightsRequired).toBeUndefined(); // el rechazo se explica por conflicto, no por mínimo
  });

  it("fuera de la ventana NADA cambia (Casa Brisa agosto: 2×2,500 + 350)", async () => {
    const { db } = makeConflictDb(0);
    const input = { property: "casa-brisa" as const, guests: 4, checkIn: "2026-08-15", checkOut: "2026-08-17" };
    const q = await buildQuote(input, db);
    expect(q!.totalHNL).toBe(5350);
    const msg = formatQuoteMessage(q!, input);
    expect(msg).toContain("2 noches × HNL 2,500 = HNL 5,000"); // desglose simple intacto
    expect(msg).not.toContain("Morazánica");
  });
});

describe("paquete Villa B11 vs Semana Morazánica — el precio fijo NO burla la temporada", () => {
  it("2 noches DENTRO de la ventana: el paquete L.5,400 NO aplica (queda la cotización de temporada)", () => {
    const q = baseQuote({ propertyName: "Villa B11 — Palma Real", totalHNL: 8150 });
    const out = applyVillaB11PackagePrice(q, "2026-10-02", "2026-10-04");
    expect(out.totalHNL).toBe(8150); // sin tocar
  });
  it("2 noches FUERA de la ventana: el paquete aplica normal", () => {
    const out = applyVillaB11PackagePrice(baseQuote(), "2026-08-15", "2026-08-17");
    expect(out.totalHNL).toBe(VILLA_B11_PACKAGE_TOTAL_HNL);
  });
  it("sin fechas (compatibilidad con llamadas viejas): aplica como siempre", () => {
    const out = applyVillaB11PackagePrice(baseQuote());
    expect(out.totalHNL).toBe(VILLA_B11_PACKAGE_TOTAL_HNL);
  });
});
