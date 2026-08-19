import { describe, it, expect } from "vitest";
import {
  isPropertyOwnerOffer,
  detectOwnerPlatformStatus,
  detectOwnerCallWillingness,
  TERMINAL_RULES,
} from "../detectors";
import { isOwnerInquiryTurn2, buildOwnerLeadSummary } from "../quote-flow";
import { T } from "../i18n";

// EXPANSIÓN (modelo B, César 2026-08-17): el bot tiene que reconocer a un DUEÑO que
// ofrece su propiedad para administración y NO tratarlo como huésped ni mandarlo al
// out_of_scope. Es el lead de mayor valor del negocio: una puerta nueva es margen casi
// puro sobre infra ya pagada.

describe("isPropertyOwnerOffer — dueño que ofrece su propiedad", () => {
  it("reconoce la oferta directa de administración", () => {
    expect(isPropertyOwnerOffer("Hola, tengo una casa y quiero que ustedes la administren")).toBe(true);
    expect(isPropertyOwnerOffer("Me gustaría que manejen mi apartamento")).toBe(true);
    expect(isPropertyOwnerOffer("Soy propietario y me interesa trabajar con ustedes")).toBe(true);
    expect(isPropertyOwnerOffer("Quisiera afiliar mi propiedad a su portafolio")).toBe(true);
    expect(isPropertyOwnerOffer("Quiero poner mi apartamento en Airbnb con ustedes")).toBe(true);
    expect(isPropertyOwnerOffer("¿Ustedes administran propiedades de terceros?")).toBe(true);
    expect(isPropertyOwnerOffer("hacen administración de propiedades?")).toBe(true);
    expect(isPropertyOwnerOffer("I have a property in Roatán, do you manage homes?")).toBe(true);
    expect(isPropertyOwnerOffer("Tengo una cabaña y quisiera que la gestionen ustedes")).toBe(true);
    expect(isPropertyOwnerOffer("¿Qué comisión cobran por administrar mi casa?")).toBe(true);
  });

  it("la zona NO descalifica: el alcance de 3 ciudades es para estadías, no para expansión", () => {
    expect(isPropertyOwnerOffer("Tengo una villa en Roatán, ¿la pueden administrar?")).toBe(true);
    expect(isPropertyOwnerOffer("Mi casa está en San Pedro Sula y quiero que la operen")).toBe(true);
  });

  it("NO confunde a un HUÉSPED que busca alojamiento con un dueño", () => {
    expect(isPropertyOwnerOffer("Quiero rentar una casa en Tela para 6 personas")).toBe(false);
    expect(isPropertyOwnerOffer("¿Tienen disponibilidad del 5 al 8 de septiembre?")).toBe(false);
    expect(isPropertyOwnerOffer("Busco un apartamento en Tegucigalpa")).toBe(false);
    expect(isPropertyOwnerOffer("¿Cuánto cuesta la villa por noche?")).toBe(false);
    expect(isPropertyOwnerOffer("Me interesa Casa Brisa para mi familia")).toBe(false);
    // Posesivo SIN intención de administración: es un huésped hablando de los suyos.
    expect(isPropertyOwnerOffer("Voy con mi casa llena de invitados, somos 8")).toBe(false);
    expect(isPropertyOwnerOffer("Mi apartamento en Tegus queda lejos, ¿está cerca?")).toBe(false);
  });

  it("REGRESIÓN 18-ago: huésped pidiendo EXTRAS de su estadía no es propietario", () => {
    // "agregar/incluir/sumar" son verbos de servicio de huésped, no de expansión —
    // con el posesivo mandaban al huésped hospedado al intake de propietarios.
    expect(isPropertyOwnerOffer("¿Me pueden agregar una cama extra en mi cabaña para este fin?")).toBe(false);
    expect(isPropertyOwnerOffer("¿Pueden incluir el desayuno en mi casa?")).toBe(false);
    expect(isPropertyOwnerOffer("¿Puedo sumar una persona más a mi apartamento?")).toBe(false);
  });

  it("REGRESIÓN 18-ago: un lead de EVENTOS con 'soy dueño' no se secuestra", () => {
    // El veto de eventos: sin intención explícita de administración, el evento gana.
    expect(isPropertyOwnerOffer("Soy dueño de un negocio y quiero un salón para un evento corporativo")).toBe(false);
    // Con administración explícita, el propietario gana aunque mencione su salón.
    expect(isPropertyOwnerOffer("Tengo una finca de eventos y quisiera que ustedes la administren")).toBe(true);
  });
});

describe("detectOwnerPlatformStatus — pregunta 2 del intake", () => {
  it("detecta que YA está en plataformas", () => {
    expect(detectOwnerPlatformStatus("Sí, está activa en Airbnb")).toBe("si");
    expect(detectOwnerPlatformStatus("la tengo en Booking y Airbnb")).toBe("si");
    expect(detectOwnerPlatformStatus("ya está publicada")).toBe("si");
  });

  it("la negación anclada a la plataforma gana sobre la mención", () => {
    expect(detectOwnerPlatformStatus("No, todavía no está en Airbnb")).toBe("no");
    expect(detectOwnerPlatformStatus("aún no la he publicado")).toBe("no");
    expect(detectOwnerPlatformStatus("es nueva, nunca la he rentado")).toBe("no");
    expect(detectOwnerPlatformStatus("quiero ponerla en Airbnb con ustedes")).toBe("no");
  });

  it("REGRESIÓN 18-ago: un 'no' de OTRA frase no contamina la calificación", () => {
    // Chat real simulado: contesta las 3 preguntas juntas. El "no" habla de la
    // llamada; la plataforma dice EXPLÍCITAMENTE que sí. Antes daba "no".
    expect(
      detectOwnerPlatformStatus("Mi casa está en Tela, ya está publicada en Airbnb, y no tengo problema con la llamada"),
    ).toBe("si");
    // Un "no" que ni siquiera habla de plataformas no puede decidir el campo.
    expect(detectOwnerPlatformStatus("Queda en una zona no muy transitada de Copán")).toBe(null);
  });

  it("null cuando no lo dice", () => {
    expect(detectOwnerPlatformStatus("Está en la playa de Tela")).toBe(null);
  });
});

describe("detectOwnerCallWillingness — pregunta 3 del intake", () => {
  it("acepta la llamada", () => {
    expect(detectOwnerCallWillingness("Sí, cuando gusten")).toBe("si");
    expect(detectOwnerCallWillingness("Dale, llámenme mañana")).toBe("si");
    // El doble-negativo hondureño es un SÍ.
    expect(detectOwnerCallWillingness("no tengo problema con la llamada")).toBe("si");
    expect(detectOwnerCallWillingness("sin problema, me pueden llamar")).toBe("si");
    // Asentimiento puro en mensaje corto.
    expect(detectOwnerCallWillingness("dale, perfecto")).toBe("si");
  });

  it("prefiere por escrito (no mata el lead, solo cambia el cierre)", () => {
    expect(detectOwnerCallWillingness("Prefiero que me escriban por acá")).toBe("no");
    expect(detectOwnerCallWillingness("Por ahora no, mejor por mensaje")).toBe("no");
    expect(detectOwnerCallWillingness("no me gustan las llamadas")).toBe("no");
  });

  it("REGRESIÓN 18-ago: un 'si' condicional o lejano no decide el campo", () => {
    // "si gustan" acá es condicional del mapa, no un sí a la llamada… pero si
    // trae "llámenme" al lado, el ancla de llamada SÍ decide.
    expect(detectOwnerCallWillingness("Está por La Ceiba, si gustan llámenme")).toBe("si");
    // Mensaje largo con "si" suelto que no habla de la llamada → null.
    expect(detectOwnerCallWillingness("La casa tiene piscina, si viene con muebles incluidos")).toBe(null);
  });

  it("null cuando no lo dice", () => {
    expect(detectOwnerCallWillingness("Está en Roatán")).toBe(null);
  });
});

describe("isOwnerInquiryTurn2 — dos anclas contra la webhook concurrente", () => {
  it("el estado alcanza", () => {
    expect(isOwnerInquiryTurn2("owner_inquiry", "")).toBe(true);
  });

  it("la última regla saliente es la RED cuando el estado se pisó", () => {
    // El estado es una fila mutable; el log de matched_rule es append-only.
    expect(isOwnerInquiryTurn2("awaiting_quote_data", "owner_lead_intake")).toBe(true);
  });

  it("no dispara en una conversación normal", () => {
    expect(isOwnerInquiryTurn2("awaiting_quote_data", "quote_sent")).toBe(false);
    expect(isOwnerInquiryTurn2(null, "")).toBe(false);
  });
});

describe("buildOwnerLeadSummary — lo que ve César para decidir la llamada", () => {
  it("trae las 3 respuestas y aclara que el bot NO negoció", () => {
    const s = buildOwnerLeadSummary("Roatán, West End", "si", "si");
    expect(s).toContain("Roatán, West End");
    expect(s).toContain("YA activa en plataformas");
    expect(s).toContain("acepta llamada");
    expect(s).toContain("NO habló de porcentaje");
  });

  it("es honesto con lo que falta en vez de inventarlo", () => {
    const s = buildOwnerLeadSummary(null, null, null);
    expect(s).toContain("sin definir");
    expect(s).toContain("plataformas s/d");
    expect(s).toContain("llamada s/d");
  });

  it("colapsa saltos de línea (Meta rechaza params multilínea, error 132018)", () => {
    const s = buildOwnerLeadSummary("Tela\nfrente al mar", "no", "no");
    expect(s).not.toContain("\n");
    expect(s).toContain("NO está en plataformas");
  });
});

describe("mensajes al propietario", () => {
  it("el intake hace las 3 preguntas de calificación de César", () => {
    const es = T.ownerIntake("es");
    expect(es).toContain("¿Dónde está ubicada su propiedad?");
    expect(es).toContain("Airbnb");
    expect(es).toContain("llamada");
    expect(T.ownerIntake("en")).toContain("Where is your property located?");
  });

  it("el intake NUNCA menciona porcentaje, comisión ni proyección (eso es de la llamada)", () => {
    for (const l of ["es", "en"] as const) {
      const txt = (T.ownerIntake(l) + T.ownerHandoff(l, "si")).toLowerCase();
      for (const prohibido of ["%", "porcentaje", "comisión", "comision", "commission", "ocupación", "occupancy"]) {
        expect(txt).not.toContain(prohibido);
      }
    }
  });

  it("el handoff se adapta a quien NO quiere llamada", () => {
    // A quien pidió NO ser llamado no se le insiste con la llamada.
    expect(T.ownerHandoff("es", "no")).toContain("por acá");
    expect(T.ownerHandoff("es", "no")).not.toContain("llamada");
    expect(T.ownerHandoff("es", "si")).toContain("llamada");
    expect(T.ownerHandoff("es", null)).toContain("llamada");
  });
});

describe("followups y watchdog", () => {
  it("un dueño derivado nunca recibe el nag de cotización", () => {
    expect(TERMINAL_RULES.has("owner_lead_handoff")).toBe(true);
  });

  it("REGRESIÓN 18-ago: el intake NO es terminal — cegaba al watchdog de bot mudo", () => {
    // El followup jamás alcanza a un dueño mid-intake (sus candidatos salen de
    // estados de cotización), así que meter el intake en TERMINAL_RULES no evitaba
    // ningún nag: solo hacía que el watchdog tratara un bot mudo tras el intake
    // como "silencio intencional" — justo en el lead de mayor valor.
    expect(TERMINAL_RULES.has("owner_lead_intake")).toBe(false);
  });
});
