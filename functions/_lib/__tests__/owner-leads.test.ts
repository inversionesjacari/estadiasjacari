import { describe, it, expect } from "vitest";
import {
  OWNER_LEAD_STAGES,
  OPEN_STAGES,
  isOwnerLeadStage,
  upsertOwnerLeadFromBot,
} from "../owner-leads";

// Pipeline de PROPIETARIOS (expansión, 2026-08-17): la tabla owner_leads es el
// embudo de puertas nuevas. Acá se blinda la inserción automática desde el bot
// (dedup por lead abierto, COALESCE que no pisa con null, fail-soft con rastro).

// ─────────────────────────────────────────────────────────────────────────────
// Fake D1 que graba cada statement con sus binds
// ─────────────────────────────────────────────────────────────────────────────

interface Call {
  sql: string;
  binds: unknown[];
}

function makeFakeDb(opts: { openLeadId?: number | null; failWrites?: boolean } = {}) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      const call: Call = { sql, binds: [] };
      const stmt = {
        bind(...args: unknown[]) {
          call.binds = args;
          return stmt;
        },
        async first() {
          calls.push(call);
          if (sql.includes("SELECT id FROM owner_leads")) {
            return opts.openLeadId ? { id: opts.openLeadId } : null;
          }
          return null;
        },
        async run() {
          calls.push(call);
          if (opts.failWrites && !call.sql.includes("bot_trace")) {
            throw new Error("D1 boom (write)");
          }
          return { meta: { changes: 1 } };
        },
        async all() {
          calls.push(call);
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de etapas
// ─────────────────────────────────────────────────────────────────────────────

describe("catálogo de etapas", () => {
  it("el embudo tiene las 6 etapas en orden y OPEN_STAGES son las vivas", () => {
    expect(OWNER_LEAD_STAGES).toEqual([
      "nuevo", "contactado", "llamada", "evaluacion", "firmado", "descartado",
    ]);
    expect(OPEN_STAGES).toEqual(["nuevo", "contactado", "llamada", "evaluacion"]);
  });

  it("isOwnerLeadStage valida el catálogo (el server rechaza etapas inventadas)", () => {
    expect(isOwnerLeadStage("llamada")).toBe(true);
    expect(isOwnerLeadStage("firmado")).toBe(true);
    expect(isOwnerLeadStage("negociando")).toBe(false);
    expect(isOwnerLeadStage("")).toBe(false);
    expect(isOwnerLeadStage(null)).toBe(false);
    expect(isOwnerLeadStage(3)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertOwnerLeadFromBot — la inserción automática del handoff
// ─────────────────────────────────────────────────────────────────────────────

describe("upsertOwnerLeadFromBot — el handoff del bot alimenta el pipeline", () => {
  it("sin lead abierto → INSERT en etapa nuevo, source bot", async () => {
    const { db, calls } = makeFakeDb({ openLeadId: null });
    await upsertOwnerLeadFromBot(db, {
      phone: "50499887766",
      location: "Roatán, West End",
      onPlatform: "si",
      callOk: "si",
    });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO owner_leads"));
    expect(insert).toBeTruthy();
    expect(insert!.sql).toContain("'nuevo'");
    expect(insert!.sql).toContain("'bot'");
    expect(insert!.binds.slice(0, 4)).toEqual(["50499887766", "Roatán, West End", "si", "si"]);
  });

  it("con lead ABIERTO para el teléfono → UPDATE, jamás una segunda fila", async () => {
    const { db, calls } = makeFakeDb({ openLeadId: 7 });
    await upsertOwnerLeadFromBot(db, {
      phone: "50499887766",
      location: "Roatán",
      onPlatform: null,
      callOk: "no",
    });
    expect(calls.some((c) => c.sql.includes("INSERT INTO owner_leads"))).toBe(false);
    const update = calls.find((c) => c.sql.includes("UPDATE owner_leads"));
    expect(update).toBeTruthy();
    // COALESCE(campo, ?): RELLENA solo lo vacío — el texto crudo del último mensaje
    // ("sí, ya está en Airbnb") no puede pisar la ubicación real ya capturada ni lo
    // que César curó a mano (revisión adversaria 18-ago).
    expect(update!.sql).toContain("COALESCE(location, ?)");
    expect(update!.sql).toContain("COALESCE(on_platform, ?)");
    expect(update!.sql).toContain("COALESCE(call_ok, ?)");
    expect(update!.binds).toEqual(["Roatán", null, "no", 7]);
  });

  it("anti-carrera: el INSERT re-chequea el lead abierto DENTRO del statement", async () => {
    // Dos webhooks concurrentes con mensajes distintos del mismo dueño pasaban el
    // SELECT (vacío ambos) y colaban DOS filas 'nuevo' (TOCTOU). El WHERE NOT
    // EXISTS del propio INSERT es el candado: D1 ejecuta el statement atómico.
    const { db, calls } = makeFakeDb({ openLeadId: null });
    await upsertOwnerLeadFromBot(db, {
      phone: "50499887766", location: "Tela", onPlatform: "si", callOk: "si",
    });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO owner_leads"));
    expect(insert).toBeTruthy();
    expect(insert!.sql).toContain("WHERE NOT EXISTS");
    // Binds: los 4 datos + el phone del re-chequeo + las 4 etapas abiertas.
    expect(insert!.binds).toEqual(["50499887766", "Tela", "si", "si", "50499887766", ...OPEN_STAGES]);
  });

  it("capa location a 200 chars en ambos caminos (mismo invariante que el API manual)", async () => {
    const testamento = "x".repeat(500);
    const { db, calls } = makeFakeDb({ openLeadId: null });
    await upsertOwnerLeadFromBot(db, {
      phone: "50499887766", location: testamento, onPlatform: null, callOk: null,
    });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO owner_leads"));
    expect((insert!.binds[1] as string).length).toBe(200);
  });

  it("el dedup SOLO mira etapas abiertas (firmado/descartado no cuentan)", async () => {
    const { db, calls } = makeFakeDb({ openLeadId: null });
    await upsertOwnerLeadFromBot(db, {
      phone: "50499887766", location: null, onPlatform: null, callOk: null,
    });
    const select = calls.find((c) => c.sql.includes("SELECT id FROM owner_leads"));
    expect(select).toBeTruthy();
    // El IN (...) lleva exactamente las 4 etapas vivas como binds (tras el phone).
    expect(select!.binds).toEqual(["50499887766", ...OPEN_STAGES]);
    expect(select!.sql).not.toContain("firmado");
    expect(select!.sql).not.toContain("descartado");
  });

  it("fail-soft: un error de D1 NO tumba el webhook y deja rastro en bot_trace", async () => {
    const { db, calls } = makeFakeDb({ openLeadId: null, failWrites: true });
    // No debe throwear — la respuesta al dueño y la alerta a César siguen su curso.
    await expect(
      upsertOwnerLeadFromBot(db, {
        phone: "50499887766", location: "Tela", onPlatform: "no", callOk: "si",
      }),
    ).resolves.toBeUndefined();
    const trace = calls.find((c) => c.sql.includes("bot_trace"));
    expect(trace).toBeTruthy();
    expect(trace!.sql).toContain("OWNER_LEAD_SAVE_FAIL");
    expect(trace!.binds[0]).toBe("50499887766");
  });
});
