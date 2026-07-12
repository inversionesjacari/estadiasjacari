import { describe, it, expect } from "vitest";
import { mergeByPhone, nextCursorOf } from "../conversations";

//
// B9 "El inbox completo" (2026-07-11). El bug más caro era que un chat ESCALADO
// o PAUSADO de hace días caía fuera del `LIMIT 100` y desaparecía de la cola de
// trabajo. Estos tests fijan las dos piezas puras del arreglo: la fusión
// pendientes+feed (que garantiza que el pendiente viejo sobreviva) y el cursor
// de paginación (que no debe ofrecer "cargar más" cuando ya no hay más).
//

// Fila mínima: mergeByPhone/nextCursorOf solo miran phone y last_at.
const row = (phone: string, last_at: string) => ({ phone, last_at }) as never;

describe("mergeByPhone — la cola de pendientes nunca se corta", () => {
  it("un pendiente VIEJO fuera del feed reciente sigue presente tras la fusión", () => {
    const feed = [row("100", "2026-07-11T10:00:00Z"), row("101", "2026-07-11T09:00:00Z")];
    const pending = [row("999", "2026-07-01T08:00:00Z")]; // escalado de hace 10 días
    const out = mergeByPhone(pending, feed);
    expect(out.map((r) => r.phone)).toContain("999");
    expect(out).toHaveLength(3);
  });

  it("un teléfono en pendientes Y en el feed no se duplica (gana la fila de pendientes)", () => {
    const feed = [row("100", "2026-07-11T10:00:00Z")];
    const pending = [row("100", "2026-07-11T10:00:00Z")];
    const out = mergeByPhone(pending, feed);
    expect(out).toHaveLength(1);
  });

  it("ordena por último mensaje descendente (el más nuevo primero)", () => {
    const feed = [row("a", "2026-07-11T08:00:00Z"), row("b", "2026-07-11T12:00:00Z")];
    const pending = [row("c", "2026-07-11T10:00:00Z")];
    const out = mergeByPhone(pending, feed);
    expect(out.map((r) => r.phone)).toEqual(["b", "c", "a"]);
  });

  it("sin pendientes se comporta como el feed a secas", () => {
    const feed = [row("a", "2026-07-11T12:00:00Z"), row("b", "2026-07-11T08:00:00Z")];
    expect(mergeByPhone([], feed).map((r) => r.phone)).toEqual(["a", "b"]);
  });
});

describe("nextCursorOf — no ofrecer 'cargar más' cuando no hay más", () => {
  it("feed lleno (== límite) → cursor = last_at del más viejo", () => {
    const feed = [row("a", "2026-07-11T12:00:00Z"), row("b", "2026-07-11T08:00:00Z")];
    expect(nextCursorOf(feed, 2)).toBe("2026-07-11T08:00:00Z");
  });

  it("feed a medio llenar (< límite) → null (no hay más páginas)", () => {
    const feed = [row("a", "2026-07-11T12:00:00Z")];
    expect(nextCursorOf(feed, 100)).toBeNull();
  });

  it("feed vacío → null", () => {
    expect(nextCursorOf([], 100)).toBeNull();
  });
});
