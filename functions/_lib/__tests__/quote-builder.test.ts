import { describe, it, expect } from "vitest";
import {
  buildQuote,
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
