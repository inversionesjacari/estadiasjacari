import { describe, expect, it } from "vitest";
import {
  buildOverlapWarning,
  findOverlappingReservations,
  type OverlapRow,
} from "../reservation-create";

//
// Chip de GEMELAS-XBLOCK-1753 (2026-07-13): la alta MANUAL del inbox solo tenía
// el guard de duplicado EXACTO — César podía cargar a mano una reserva que PISA
// otra pending/confirmed sin ningún aviso (incluido el cruce del combo Las
// Gemelas ↔ Brisa/Marea). Política que fijan estos tests: ADVERTIR sin bloquear
// (la alta manual registra hechos que César ya conoce; el aviso le deja decidir
// si es doble venta) y el chequeo es advisory (un error de D1 nunca frena la carga).
//

/** Stub mínimo de D1 que graba SQL + binds (patrón paypal-wa-capture.test). */
function makeDb(opts: { rows?: OverlapRow[]; throws?: boolean } = {}) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all() {
              calls.push({ sql, binds });
              if (opts.throws) throw new Error("D1 boom");
              return { results: opts.rows ?? [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const row = (over: Partial<OverlapRow> = {}): OverlapRow => ({
  property_slug: "casa-brisa",
  check_in: "2026-08-14",
  check_out: "2026-08-16",
  guest_name: "Ana López",
  status: "confirmed",
  ...over,
});

describe("findOverlappingReservations — el cruce que el guard de duplicado exacto no ve", () => {
  it("propiedad sin combo (villa-b11): consulta SOLO su slug, con el par medio-abierto [in, out)", async () => {
    const { db, calls } = makeDb();
    await findOverlappingReservations(db, "villa-b11-palma-real", "2026-08-15", "2026-08-17");

    expect(calls).toHaveLength(1);
    const { sql, binds } = calls[0];
    // Solape real, no fechas exactas: existente.check_in < nueva.check_out AND
    // existente.check_out > nueva.check_in (back-to-back NO es solape).
    expect(sql).toContain("check_in < ? AND check_out > ?");
    expect(sql).toContain("status IN ('pending','confirmed')");
    // El orden de los binds es la plata: check_out va contra `check_in <` y
    // check_in contra `check_out >`.
    expect(binds).toEqual(["villa-b11-palma-real", "2026-08-17", "2026-08-15"]);
  });

  it("las-gemelas-tela expande a las 3 (combo + brisa + marea)", async () => {
    const { db, calls } = makeDb();
    await findOverlappingReservations(db, "las-gemelas-tela", "2026-08-15", "2026-08-17");

    const { sql, binds } = calls[0];
    expect(binds.slice(0, 3)).toEqual(["las-gemelas-tela", "casa-brisa", "casa-marea"]);
    // Un placeholder por slug expandido (el IN calza con los binds).
    expect(sql).toContain("IN (?, ?, ?)");
  });

  it("casa-brisa cruza SOLO hacia el combo — casa-marea es otra casa y no bloquea", async () => {
    const { db, calls } = makeDb();
    await findOverlappingReservations(db, "casa-brisa", "2026-08-15", "2026-08-17");

    const { binds } = calls[0];
    expect(binds).toContain("casa-brisa");
    expect(binds).toContain("las-gemelas-tela");
    expect(binds).not.toContain("casa-marea");
  });

  it("devuelve las filas de D1 tal cual", async () => {
    const rows = [row(), row({ property_slug: "las-gemelas-tela", guest_name: null })];
    const { db } = makeDb({ rows });
    const out = await findOverlappingReservations(db, "casa-brisa", "2026-08-15", "2026-08-17");
    expect(out).toEqual(rows);
  });

  it("error de D1 → [] (advisory: un fallo del chequeo nunca frena la carga manual)", async () => {
    const { db } = makeDb({ throws: true });
    const out = await findOverlappingReservations(db, "casa-brisa", "2026-08-15", "2026-08-17");
    expect(out).toEqual([]);
  });
});

describe("buildOverlapWarning — advertir sin bloquear", () => {
  it("sin solapes → null (la respuesta queda limpia)", () => {
    expect(buildOverlapWarning("casa-brisa", [])).toBeNull();
  });

  it("solape simple: nombra propiedad, fechas, huésped y estado, y pide revisar doble venta", () => {
    const w = buildOverlapWarning("casa-brisa", [row()]);
    expect(w).toContain("Casa Brisa");
    expect(w).toContain("2026-08-14 → 2026-08-16");
    expect(w).toContain("de Ana López");
    expect(w).toContain("confirmada");
    expect(w).toContain("doble venta");
    // Mismo slug: la nota del combo sobra.
    expect(w).not.toContain("ocupa Casa Brisa + Casa Marea");
  });

  it("cruce del combo (alta de casa-brisa pisada por las-gemelas) → explica que el combo ocupa las 2 casas", () => {
    const w = buildOverlapWarning("casa-brisa", [row({ property_slug: "las-gemelas-tela" })]);
    expect(w).toContain("Las Gemelas (Tela)");
    expect(w).toContain("Las Gemelas ocupa Casa Brisa + Casa Marea");
  });

  it("pending → 'por verificar'; sin nombre de huésped no inventa el 'de …'", () => {
    const w = buildOverlapWarning("casa-brisa", [row({ status: "pending", guest_name: null })]);
    expect(w).toContain("por verificar");
    expect(w).not.toContain(" de ");
  });

  it("más de 3 solapes: nombra 3 y avisa que hay más", () => {
    const rows = [
      row({ check_in: "2026-08-10", check_out: "2026-08-12", guest_name: "A" }),
      row({ check_in: "2026-08-12", check_out: "2026-08-14", guest_name: "B" }),
      row({ check_in: "2026-08-14", check_out: "2026-08-16", guest_name: "C" }),
      row({ check_in: "2026-08-16", check_out: "2026-08-18", guest_name: "D" }),
    ];
    const w = buildOverlapWarning("casa-brisa", rows)!;
    expect(w).toContain("de C");
    expect(w).not.toContain("de D");
    expect(w).toContain("y hay más");
  });
});
