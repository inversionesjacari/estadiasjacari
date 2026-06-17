import { describe, it, expect } from "vitest";
import {
  resolveDates,
  extractDatePhrases,
  extractNights,
  addDaysIso,
  isValidIso,
} from "../date-parser";

// today fijo para todos los tests. 2026-06-15 es LUNES (verificado).
const TODAY = "2026-06-15";

describe("helpers de fecha", () => {
  it("addDaysIso suma días cruzando meses", () => {
    expect(addDaysIso("2026-06-15", 1)).toBe("2026-06-16");
    expect(addDaysIso("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("isValidIso rechaza fechas inexistentes", () => {
    expect(isValidIso("2026-07-17")).toBe(true);
    expect(isValidIso("2026-02-30")).toBe(false);
    expect(isValidIso("2026-13-01")).toBe(false);
    expect(isValidIso(null)).toBe(false);
    expect(isValidIso("17 de julio")).toBe(false);
  });
});

describe("extractNights — G4: noches NUNCA salen de personas", () => {
  it("toma noches explícitas", () => {
    expect(extractNights("3 noches")).toBe(3);
    expect(extractNights("una noche")).toBe(1);
    expect(extractNights("4 dias")).toBe(4);
    expect(extractNights("una semana")).toBe(7);
    expect(extractNights("2 semanas")).toBe(14);
  });
  it("NO confunde adultos/personas/huéspedes con noches (bug Sara)", () => {
    expect(extractNights("4 adultos")).toBeNull();
    expect(extractNights("para 4 personas y 1 niña")).toBeNull();
    expect(extractNights("somos 5 huespedes")).toBeNull();
    expect(extractNights("sábado 20, 4 adultos")).toBeNull();
  });
});

describe("extractDatePhrases — fechas relativas", () => {
  it('"mañana" = hoy+1 (no el sentido "por la mañana")', () => {
    expect(extractDatePhrases("llego mañana", TODAY).checkIn).toBe("2026-06-16");
    expect(extractDatePhrases("salgo mañana", TODAY).checkIn).toBe("2026-06-16");
    // "9 de la mañana" es horario, NO fecha
    expect(extractDatePhrases("llego a las 9 de la mañana", TODAY).checkIn).toBeNull();
  });
  it('"pasado mañana" = hoy+2', () => {
    expect(extractDatePhrases("voy pasado mañana", TODAY).checkIn).toBe("2026-06-17");
  });
  it('"hoy" = today', () => {
    expect(extractDatePhrases("puedo llegar hoy", TODAY).checkIn).toBe("2026-06-15");
  });
  it("día de semana = próxima ocurrencia (today es lunes)", () => {
    expect(extractDatePhrases("el domingo", TODAY).checkIn).toBe("2026-06-21");
    expect(extractDatePhrases("el martes", TODAY).checkIn).toBe("2026-06-16");
    // "el lunes" siendo hoy lunes → el próximo lunes
    expect(extractDatePhrases("el lunes", TODAY).checkIn).toBe("2026-06-22");
  });
  it('"este fin de semana" = viernes→domingo', () => {
    const r = extractDatePhrases("quiero ir este fin de semana", TODAY);
    expect(r.checkIn).toBe("2026-06-19");
    expect(r.checkOut).toBe("2026-06-21");
  });
});

describe("extractDatePhrases — fechas explícitas con mes (resolución de año)", () => {
  it('"17 de julio" estando en junio → ESTE año, mes correcto (bug lead-perdido)', () => {
    expect(extractDatePhrases("disponible para el 17 de julio?", TODAY).checkIn).toBe("2026-07-17");
  });
  it("mes ya pasado este año → el próximo año", () => {
    expect(extractDatePhrases("el 5 de enero", TODAY).checkIn).toBe("2027-01-05");
  });
  it("rango con mes: del 17 al 19 de julio", () => {
    const r = extractDatePhrases("del 17 al 19 de julio", TODAY);
    expect(r.checkIn).toBe("2026-07-17");
    expect(r.checkOut).toBe("2026-07-19");
  });
  it("rango cruzando meses: del 28 de julio al 2 de agosto", () => {
    const r = extractDatePhrases("del 28 de julio al 2 de agosto", TODAY);
    expect(r.checkIn).toBe("2026-07-28");
    expect(r.checkOut).toBe("2026-08-02");
  });
  it("numérica día/mes: 17/07", () => {
    expect(extractDatePhrases("llego el 17/07", TODAY).checkIn).toBe("2026-07-17");
  });
});

describe("resolveDates — integrador con garantías G1-G4", () => {
  it("G3: el texto gana sobre el ISO equivocado del LLM", () => {
    // El LLM puso junio (mes equivocado); el cliente dijo julio.
    const r = resolveDates("17 de julio", "2026-06-17", null, TODAY);
    expect(r.checkIn).toBe("2026-07-17");
    expect(r.corrected).toBe(true);
  });
  it("G1: nunca un check-in en el pasado — bump de año si el LLM usó el año viejo", () => {
    const r = resolveDates("para el 17 de julio", "2025-07-17", null, TODAY);
    expect(r.checkIn).toBe("2026-07-17");
  });
  it("G1: fallback del LLM muy pasado y sin pista en el texto → null (mejor preguntar que cotizar el pasado)", () => {
    // ensureFuture sube como mucho +2 años; 2020 no se recupera → null.
    const r = resolveDates("dale", "2020-01-10", null, TODAY);
    expect(r.checkIn).toBeNull();
    expect(r.checkOut).toBeNull();
  });
  it("G2: check-out mal ordenado y sin noches → se descarta", () => {
    const r = resolveDates("dale", "2026-07-20", "2026-07-18", TODAY);
    expect(r.checkIn).toBe("2026-07-20");
    expect(r.checkOut).toBeNull();
  });
  it("noches explícitas derivan el check-out", () => {
    const r = resolveDates("llego hoy y me quedo 2 noches", null, null, TODAY);
    expect(r.checkIn).toBe("2026-06-15");
    expect(r.checkOut).toBe("2026-06-17");
    expect(r.nights).toBe(2);
  });
  it("G4: 'sábado 20 ... 4 adultos' NO inventa 4 noches", () => {
    // El parser no fabrica check-out desde 'adultos'; si el LLM tampoco dio salida real, queda null.
    const r = resolveDates("para el 20 de junio, 4 adultos", null, null, TODAY);
    expect(r.checkIn).toBe("2026-06-20");
    expect(r.checkOut).toBeNull();
    expect(r.nights).toBeNull();
  });
  it("multi-turno: sin fecha en el mensaje actual, conserva lo previo del LLM (validado)", () => {
    const r = resolveDates("perfecto, gracias", "2026-07-17", "2026-07-19", TODAY);
    expect(r.checkIn).toBe("2026-07-17");
    expect(r.checkOut).toBe("2026-07-19");
    expect(r.nights).toBe(2);
    expect(r.corrected).toBe(false);
  });
});
