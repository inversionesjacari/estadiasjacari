import { describe, it, expect } from "vitest";
import { resolveDates, extractNights } from "../../date-parser";
import {
  isConfirmation,
  isNotInterested,
  isCheckinTimeRequest,
} from "../../detectors";

//
// GOLDEN DATASET — la especificación VIVA del bot.
//
// Cada bloque de acá es un CHAT REAL que falló (ver references/patrones-de-fallo.md).
// Lo expresamos como el invariante DETERMINÍSTICO que, de haber estado, lo evitaba.
//
// 📌 Regla de la skill doctor-bot-jacari: cuando César traiga un chat nuevo que
//    salió mal, además de arreglar la causa, AGREGÁ acá su caso. Un fix sin test
//    no está terminado. Así el bot CONVERGE en vez de re-romperse.
//
// (Los casos que dependen de la clasificación del LLM —p.ej. out_of_scope— solo se
//  pueden verificar end-to-end con el modelo; acá fijamos la parte determinística que
//  el flujo SÍ controla, que es la red de seguridad que más bugs cazó.)
//

// La mayoría de estos chats ocurrieron a mediados de junio 2026.
const TODAY = "2026-06-15"; // lunes

describe("CHAT: lead-perdido — el bot inventó que '17 de julio' ya pasó", () => {
  it("'17 de julio' estando en junio resuelve a julio FUTURO, jamás al pasado", () => {
    // El cliente preguntó por el 17 de julio; el bot razonó mal el mes/año.
    const r = resolveDates("¿pero sí estaría disponible para el 17 de julio?", null, null, TODAY);
    expect(r.checkIn).toBe("2026-07-17");
    expect(r.checkIn! >= TODAY).toBe(true);
  });
  it("aunque el LLM mande el mes equivocado, el parser lo corrige", () => {
    const r = resolveDates("para el 17 de julio", "2026-06-17", null, TODAY);
    expect(r.checkIn).toBe("2026-07-17");
  });
});

describe("CHAT: Sara — '4 adultos' confundido con '4 noches'", () => {
  it("'4 adultos' NO produce noches ni un check-out fabricado", () => {
    expect(extractNights("somos 4 adultos")).toBeNull();
    const r = resolveDates("para el 20 de junio, 4 adultos", null, null, TODAY);
    expect(r.checkIn).toBe("2026-06-20");
    expect(r.checkOut).toBeNull(); // sin salida real → el bot debe PEDIRLA, no inventar
    expect(r.nights).toBeNull();
  });
});

describe("CHAT: Zedileth — 'si estaría disponible' tratado como un 'sí, cobrale'", () => {
  it("la pregunta de disponibilidad no es confirmación", () => {
    expect(isConfirmation("Pero si estaría disponible para el 17 de junio?")).toBe(false);
  });
});

describe("CHAT: Sandra — pregunta de horario tragada en el paso de pago", () => {
  it("la pregunta por la hora de entrada se detecta aunque esté eligiendo pago", () => {
    expect(isCheckinTimeRequest("y a qué hora puedo entrar?")).toBe(true);
    expect(isCheckinTimeRequest("cuál es el horario de check in y check out?")).toBe(true);
  });
});

describe("CHAT: Claudia María — lead caliente mal mandado a 'fuera de alcance'", () => {
  it("describir lo que busca NO es un rechazo (no lo cerramos como desinteresado)", () => {
    // La parte determinística que controlamos: no tratarlo como 'no interesado'.
    // (Que el LLM no lo mande a out_of_scope se valida end-to-end con el modelo.)
    expect(isNotInterested("quiero un lugar para compartir con mi familia y cocinar")).toBe(false);
    expect(isNotInterested("busco algo tranquilo para descansar con mis hermanos")).toBe(false);
  });
});
