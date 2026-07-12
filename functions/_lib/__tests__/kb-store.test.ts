/// <reference types="@cloudflare/workers-types" />
//
// kb-store.test.ts — La KB de D1 y su fallback al hardcode.
//
// Qué cubre (sesión KB-VIVA-2200, doc 05_automatizacion/12_kb_conocimiento_decision.md):
//   1. El fallback al hardcode deja LATIDO `kb_fallback_hardcode` (antes era
//      100% silencioso — el bot podía ignorar el panel /inbox/conocimiento
//      para siempre sin que nadie se enterara).
//   2. El camino poblado usa D1 (el precio del panel gana) y NO deja latido.
//   3. Error de lectura ≡ tabla vacía (los getters se tragan el error): ambos
//      caen al hardcode CON latido.
//   4. El latido es best-effort: si la escritura falla, el fallback sale igual.
//   5. Acoplamiento documentado: kb_properties vacía DESCARTA rules/policies/faqs
//      aunque tengan filas (el hardcode no tiene sección de reglas).
//   6. Guardia anti-drift: los precios del hardcode PROPERTY_KNOWLEDGE_BASE
//      (prosa) deben coincidir con PROPERTY_PRICING (lo que se cobra de verdad).
//      Cazó un drift real: Las Gemelas decía L.5,000 en prosa y el motor cobraba
//      L.4,900 (César resolvió 2026-07-11: estándar = 5,000, el 4,900 era error).
//      Desde entonces la prosa INTERPOLA los precios desde PROPERTY_PRICING;
//      este guardia queda como red por si alguien vuelve a escribirlos a mano.
//

import { describe, it, expect } from "vitest";
import { buildPricingMap, buildKnowledgeBaseText } from "../kb-store";
import { PROPERTY_PRICING } from "../quote-builder";
import { PROPERTY_KNOWLEDGE_BASE } from "../property-kb";

// ─────────────────────────────────────────────────────────────────────────────
// Fake D1 mínimo: rutea por substring del SQL y registra los INSERT de latido.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeDbOpts {
  properties?: Record<string, unknown>[];
  policies?: Record<string, unknown>[];
  faqs?: Record<string, unknown>[];
  rules?: Record<string, unknown>[];
  failReads?: boolean; // los SELECT throwean (los getters lo tragan y devuelven [])
  failWrites?: boolean; // el INSERT del latido throwea (debe tragarse, best-effort)
}

function makeFakeDb(opts: FakeDbOpts = {}) {
  const heartbeatWrites: string[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(..._args: unknown[]) {
          return stmt;
        },
        async all() {
          if (opts.failReads) throw new Error("D1 boom (read)");
          if (sql.includes("kb_properties")) return { results: opts.properties ?? [] };
          if (sql.includes("kb_policies")) return { results: opts.policies ?? [] };
          if (sql.includes("kb_faqs")) return { results: opts.faqs ?? [] };
          if (sql.includes("kb_rules")) return { results: opts.rules ?? [] };
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          if (opts.failWrites) throw new Error("D1 boom (write)");
          if (sql.includes("system_heartbeat")) heartbeatWrites.push(sql);
          return {};
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, heartbeatWrites };
}

/** Fila completa de kb_properties (snake_case, como sale de D1). */
function propRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "casa-brisa",
    name: "Casa Brisa",
    city: "Tela",
    capacity: 6,
    bedrooms: 2,
    bathrooms: 2,
    beds: "Principal: 1 Queen",
    price_night_hnl: 2500,
    cleaning_hnl: 350,
    price_night_usd: 90,
    cleaning_usd: 14,
    aliases: null,
    amenities: "WiFi",
    pool: null,
    beach: null,
    pets: null,
    parking: null,
    tv: null,
    ideal_for: null,
    notes: null,
    sort_order: 1,
    active: 1,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildPricingMap
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPricingMap — fallback con latido", () => {
  it("D1 vacía → devuelve PROPERTY_PRICING hardcoded Y deja latido kb_fallback_hardcode", async () => {
    const { db, heartbeatWrites } = makeFakeDb({ properties: [] });
    const map = await buildPricingMap(db);
    expect(map).toBe(PROPERTY_PRICING);
    expect(heartbeatWrites).toHaveLength(1);
    expect(heartbeatWrites[0]).toContain("kb_fallback_hardcode");
  });

  it("D1 con error de lectura ≡ vacía → fallback CON latido (el error se traga)", async () => {
    const { db, heartbeatWrites } = makeFakeDb({ failReads: true });
    const map = await buildPricingMap(db);
    expect(map).toBe(PROPERTY_PRICING);
    expect(heartbeatWrites).toHaveLength(1);
  });

  it("D1 poblada → el precio del panel GANA y NO hay latido", async () => {
    const { db, heartbeatWrites } = makeFakeDb({
      properties: [propRow({ price_night_hnl: 2700, price_night_usd: 99 })],
    });
    const map = await buildPricingMap(db);
    expect(map["casa-brisa"].pricePerNightHNL).toBe(2700);
    expect(map["casa-brisa"].pricePerNightUSD).toBe(99);
    expect(heartbeatWrites).toHaveLength(0);
  });

  it("slug ausente en D1 conserva el fallback del código (las-gemelas-tela nunca está en D1)", async () => {
    const { db } = makeFakeDb({ properties: [propRow()] });
    const map = await buildPricingMap(db);
    expect(map["las-gemelas-tela"]).toEqual(PROPERTY_PRICING["las-gemelas-tela"]);
  });

  it("si la ESCRITURA del latido falla, el fallback sale igual (best-effort, nunca throws)", async () => {
    const { db } = makeFakeDb({ properties: [], failWrites: true });
    await expect(buildPricingMap(db)).resolves.toBe(PROPERTY_PRICING);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildKnowledgeBaseText
// ─────────────────────────────────────────────────────────────────────────────

describe("buildKnowledgeBaseText — fallback con latido y acoplamiento de reglas", () => {
  it("kb_properties vacía → hardcode + latido, y DESCARTA las reglas aunque existan (acoplamiento documentado)", async () => {
    const { db, heartbeatWrites } = makeFakeDb({
      properties: [],
      rules: [{ id: 1, rule: "Regla fantasma que se pierde", sort_order: 1, active: 1 }],
    });
    const text = await buildKnowledgeBaseText(db);
    expect(text).toBe(PROPERTY_KNOWLEDGE_BASE);
    expect(text).not.toContain("Regla fantasma");
    expect(heartbeatWrites).toHaveLength(1);
    expect(heartbeatWrites[0]).toContain("kb_fallback_hardcode");
  });

  it("poblada → reglas al TOPE + propiedades por ciudad + políticas + FAQs, sin latido", async () => {
    const { db, heartbeatWrites } = makeFakeDb({
      properties: [propRow()],
      rules: [{ id: 1, rule: "Sé cálido y natural", sort_order: 1, active: 1 }],
      policies: [{ key: "check_in", label: "Check-in", value: "3:00 PM", sort_order: 1 }],
      faqs: [{ id: 1, question: "¿Tienen WiFi?", answer: "Sí", sort_order: 1, active: 1 }],
    });
    const text = await buildKnowledgeBaseText(db);
    expect(text).toContain("REGLAS DEL NEGOCIO");
    expect(text).toContain("Sé cálido y natural");
    expect(text).toContain("## Propiedades de Tela");
    expect(text).toContain("Casa Brisa");
    expect(text).toContain("Check-in: 3:00 PM");
    expect(text).toContain("¿Tienen WiFi?");
    // Las reglas van ANTES de las propiedades (máxima prioridad para el LLM).
    expect(text.indexOf("REGLAS DEL NEGOCIO")).toBeLessThan(text.indexOf("## Propiedades de"));
    expect(heartbeatWrites).toHaveLength(0);
  });

  it("propiedad inactiva (active=0) no aparece en el texto", async () => {
    const { db } = makeFakeDb({
      properties: [propRow(), propRow({ slug: "la-florida", name: "La Florida", city: "Tegucigalpa", active: 0 })],
    });
    const text = await buildKnowledgeBaseText(db);
    expect(text).toContain("Casa Brisa");
    expect(text).not.toContain("La Florida");
  });

  it("TODAS inactivas → latido (panel ignorado) pero SIN resucitar el hardcode: lo apagado queda apagado", async () => {
    const { db, heartbeatWrites } = makeFakeDb({
      properties: [propRow({ active: 0 }), propRow({ slug: "la-florida", name: "La Florida", city: "Tegucigalpa", active: 0 })],
      rules: [{ id: 1, rule: "Sé cálido y natural", sort_order: 1, active: 1 }],
    });
    const text = await buildKnowledgeBaseText(db);
    expect(text).not.toBe(PROPERTY_KNOWLEDGE_BASE); // no resucita propiedades apagadas
    expect(text).not.toContain("Casa Brisa");
    expect(text).toContain("Sé cálido y natural"); // reglas/políticas/faqs siguen vivas
    expect(heartbeatWrites).toHaveLength(1);
    expect(heartbeatWrites[0]).toContain("kb_fallback_hardcode");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guardia anti-drift: prosa hardcoded vs precios reales del código
// ─────────────────────────────────────────────────────────────────────────────

/** 4900 → "4,900" (formato manual, sin depender del locale del runner). */
function fmt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Ancla cada chequeo a la SECCIÓN de esa propiedad en la prosa (header ###).
// Sin el ancla, los precios repetidos (tres casas a L.2,500) dejan pasar drift
// de una sección cubierto por la vecina. Si un header se renombra, el test
// también falla — eso TAMBIÉN es drift (el mapa de abajo es el contrato).
const PROSE_SECTION_HEADER: Record<string, string> = {
  "villa-b11-palma-real": "### Villa B11 — Hotel Palma Real",
  "casa-brisa": "### Casa Brisa",
  "casa-marea": "### Casa Marea",
  "las-gemelas-tela": "### Las Gemelas (Casa Brisa + Casa Marea juntas)",
  "centro-morazan": "### Centro Morazán (Apartamento de lujo)",
  "casa-lara-townhouse": "### Casa Lara Townhouse",
  "la-florida": "### La Florida",
};

function proseSection(slug: string): string {
  const header = PROSE_SECTION_HEADER[slug];
  const start = PROPERTY_KNOWLEDGE_BASE.indexOf(`${header}\n`);
  if (start === -1) return ""; // header renombrado/borrado → el test falla con sección vacía
  const next = PROPERTY_KNOWLEDGE_BASE.indexOf("\n### ", start + header.length);
  return next === -1 ? PROPERTY_KNOWLEDGE_BASE.slice(start) : PROPERTY_KNOWLEDGE_BASE.slice(start, next);
}

describe("anti-drift: PROPERTY_KNOWLEDGE_BASE (prosa) vs PROPERTY_PRICING (lo que se cobra)", () => {
  // Si esto falla: alguien volvió a escribir un monto A MANO en la prosa (hoy
  // se interpolan desde PROPERTY_PRICING) o rompió el template de la tarifa.
  // La fuente de verdad de lo COBRADO es PROPERTY_PRICING (con D1 encima).
  // Historia: cazó el drift real de Las Gemelas (prosa 5,000 vs motor 4,900).
  for (const [slug, p] of Object.entries(PROPERTY_PRICING)) {
    it(`${slug}: SU sección de la prosa dice la tarifa completa real (noche+limpieza, HNL+USD)`, () => {
      const section = proseSection(slug);
      expect(section, `header "${PROSE_SECTION_HEADER[slug]}" no encontrado en la prosa`).not.toBe("");
      expect(section).toContain(
        `L.${fmt(p.pricePerNightHNL)} por noche + L.${fmt(p.cleaningFeeHNL)} de limpieza (≈ USD ${p.pricePerNightUSD}/noche + USD ${p.cleaningFeeUSD} limpieza)`,
      );
    });
  }
});
