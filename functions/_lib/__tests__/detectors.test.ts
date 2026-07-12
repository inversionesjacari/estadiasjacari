import { describe, it, expect } from "vitest";
import {
  isConfirmation,
  isAvailabilityDatesRequest,
  isCapacityQuestion,
  isBankAccountRequest,
  isBedroomPhotoRequest,
  isPhotoRequest,
  isCheckinTimeRequest,
  isNotInterested,
  isLegitimacyQuestion,
  isPhoneNumberRequest,
  isLocationRequest,
  isLongTermRequest,
  nightsBetween,
  cityFromText,
  hasInScopeSignal,
  TERMINAL_RULES,
  isFarewell,
  isEventInquiry,
  mentionsValleDeAngeles,
  detectPackageInquiry,
  detectPackageByAdPrice,
} from "../detectors";

// Cada caso de acá es un BUG REAL que ya vimos (ver references/patrones-de-fallo.md).
// Si una regex se "mejora" y rompe uno, el test lo caza antes del cliente.

describe("isConfirmation — 'si' suele ser 'if', no 'sí'", () => {
  it("una pregunta de disponibilidad NO es confirmación (bug Zedileth)", () => {
    expect(isConfirmation("Pero si estaría disponible para el 17 de junio?")).toBe(false);
  });
  it("una despedida cortés sola NO confirma (no la mandes a pagar)", () => {
    expect(isConfirmation("Ok buen día")).toBe(false);
  });
  it("un 'sí' fuerte + despedida SÍ confirma", () => {
    expect(isConfirmation("perfecto, buen día")).toBe(true);
  });
  it("confirmaciones claras", () => {
    expect(isConfirmation("sí dale")).toBe(true);
    expect(isConfirmation("de acuerdo")).toBe(true);
  });
  it("negaciones no confirman", () => {
    expect(isConfirmation("no, mejor no")).toBe(false);
    expect(isConfirmation("ya no")).toBe(false);
  });
  it("'si' + cláusula que sigue indecisa NO confirma (casos reales 10-jul-2026)", () => {
    // SSC: objeción (Casa Marea cotizada no tiene piscina), no un "sí, reservo".
    expect(isConfirmation("Si andamos buscando casa con Piscina")).toBe(false);
    // Chat ".": todavía espera que otros decidan, no confirmó nada.
    expect(isConfirmation("Si, estoy  a la espera  de la.confirmacion de otras personas.")).toBe(false);
  });
  it("intención explícita de reservar confirma aunque no diga 'sí' (caso real Gina Moncada)", () => {
    expect(isConfirmation("Quiero reservar")).toBe(true);
    expect(isConfirmation("Sii quisiera saber que debo hacer para reservar")).toBe(true);
  });
});

describe("isBankAccountRequest — blinda contra inventar cuenta", () => {
  it("pedir la cuenta para transferir", () => {
    expect(isBankAccountRequest("a qué cuenta transfiero?")).toBe(true);
    expect(isBankAccountRequest("me das los datos bancarios")).toBe(true);
  });
  it("NO roba 'número de personas'", () => {
    expect(isBankAccountRequest("somos un número de 5 personas")).toBe(false);
  });
});

describe("isBedroomPhotoRequest — habitaciones, no la sala", () => {
  it("pide fotos de las habitaciones (incluye typo 'abitaciones')", () => {
    expect(isBedroomPhotoRequest("me mandás fotos de las habitaciones?")).toBe(true);
    expect(isBedroomPhotoRequest("fotos de las abitaciones")).toBe(true);
    expect(isBedroomPhotoRequest("quiero ver los cuartos")).toBe(true);
  });
  it("fotos de la casa en general NO es pedido de dormitorios", () => {
    expect(isBedroomPhotoRequest("fotos de la casa")).toBe(false);
  });
});

describe("isCheckinTimeRequest — el paso de pago no debe tragarse la pregunta (bug Sandra)", () => {
  it("pregunta por la hora de entrada", () => {
    expect(isCheckinTimeRequest("a qué hora puedo entrar?")).toBe(true);
    expect(isCheckinTimeRequest("cuál es el horario de check-in?")).toBe(true);
    expect(isCheckinTimeRequest("what time is check-in?")).toBe(true);
  });
  it("NO roba 'a qué cuenta' ni 'cuántas personas'", () => {
    expect(isCheckinTimeRequest("a qué cuenta deposito?")).toBe(false);
    expect(isCheckinTimeRequest("cuántas personas caben?")).toBe(false);
  });
});

describe("isNotInterested — cerrar sin insistir", () => {
  it("rechazo directo / por precio / despedida sola", () => {
    expect(isNotInterested("no me interesa")).toBe(true);
    expect(isNotInterested("está muy caro")).toBe(true);
    expect(isNotInterested("gracias")).toBe(true);
  });
  it("'gracias, ¿cómo pago?' NO es desinterés", () => {
    expect(isNotInterested("gracias, ¿cómo pago?")).toBe(false);
  });
  it("'no tengo dinero' es rechazo aunque venga con un 'gracias' pegado (hueco de la métrica B3)", () => {
    expect(isNotInterested("gracias pero no tengo dinero")).toBe(true);
    expect(isNotInterested("no tengo esa cantidad ahorita")).toBe(true);
    expect(isNotInterested("no cuento con el presupuesto por ahora")).toBe(true);
  });
  it("'no tengo tarjeta' NO es rechazo (es un problema de método de pago, no de plata)", () => {
    expect(isNotInterested("no tengo tarjeta")).toBe(false);
  });
});

describe("isLegitimacyQuestion — la objeción más cara antes de transferir", () => {
  it("dudas de estafa/realidad", () => {
    expect(isLegitimacyQuestion("¿esto es estafa?")).toBe(true);
    expect(isLegitimacyQuestion("¿son reales?")).toBe(true);
    expect(isLegitimacyQuestion("is this a scam?")).toBe(true);
  });
  it("NO roba 'número de cuenta'", () => {
    expect(isLegitimacyQuestion("me das el número de cuenta")).toBe(false);
  });
});

describe("otros detectores clave", () => {
  it("isPhotoRequest cubre pedir el instagram", () => {
    expect(isPhotoRequest("me pasás el instagram?")).toBe(true);
    expect(isPhotoRequest("tienen fotos?")).toBe(true);
  });
  it("isPhoneNumberRequest pide un teléfono (no que lo llamen)", () => {
    expect(isPhoneNumberRequest("me das un número de teléfono?")).toBe(true);
  });
  it("isLocationRequest pide ubicación/mapa", () => {
    expect(isLocationRequest("dónde queda?")).toBe(true);
    expect(isLocationRequest("me pasás la ubicación?")).toBe(true);
  });
  it("isLongTermRequest detecta renta a largo plazo", () => {
    expect(isLongTermRequest("busco algo por varios meses")).toBe(true);
  });
  it("nightsBetween cuenta noches", () => {
    expect(nightsBetween("2026-07-17", "2026-07-19")).toBe(2);
    expect(nightsBetween("2026-07-17", "2026-07-17")).toBe(0);
  });
});

describe("TERMINAL_RULES — fuente única para no confundir cierre intencional con falla (B2)", () => {
  it("incluye 'farewell' — sin esto, watchdog.ts trataría un closing_ack_silent como bot mudo", () => {
    expect(TERMINAL_RULES.has("farewell")).toBe(true);
  });
  it("incluye las reglas de escalación que quote-followups.ts ya dependía", () => {
    expect(TERMINAL_RULES.has("existing_guest_escalation")).toBe(true);
    expect(TERMINAL_RULES.has("payment_reported")).toBe(true);
    expect(TERMINAL_RULES.has("transfer_confirmed_deposit")).toBe(true);
  });
  it("NO incluye reglas de flujo normal (no deben cortar followups/watchdog)", () => {
    expect(TERMINAL_RULES.has("bot_gathering_data")).toBe(false);
    expect(TERMINAL_RULES.has("quote_provided")).toBe(false);
  });
});

describe("cityFromText / hasInScopeSignal — caso Alisson + su hueco corregido", () => {
  it("ciudades nuestras se detectan sin LLM", () => {
    expect(cityFromText("Ceiba")).toBe("La Ceiba");
    expect(cityFromText("Tegucigalpa")).toBe("Tegucigalpa");
    expect(cityFromText("Tela")).toBe("Tela");
  });
  it("un grupo grande SOLO (sin ciudad/propiedad nuestra) no fuerza in-scope", () => {
    expect(hasInScopeSignal("Roatán para 8 personas", null, null, null, null)).toBe(false);
  });
  it("ciudad nombrada, extraída por el LLM, o ya fijada en el estado — cualquiera alcanza", () => {
    expect(hasInScopeSignal("Ceiba", null, null, null, null)).toBe(true);
    expect(hasInScopeSignal("y para 8?", "Tegucigalpa", null, null, null)).toBe(true);
    expect(hasInScopeSignal("y para 8?", null, null, "Tela", null)).toBe(true);
    expect(hasInScopeSignal("y para 8?", null, "casa-brisa", null, null)).toBe(true);
  });
});

describe("isFarewell — 'no' suelto o con texto extra no se reconocía como cierre (bug 7-jul-2026)", () => {
  it("un 'No' suelto es cierre", () => {
    expect(isFarewell("No")).toBe(true);
    expect(isFarewell("no.")).toBe(true);
  });
  it("'no' + razón corta + 'gracias' es cierre, aunque haya texto en medio", () => {
    expect(isFarewell("No, pue son nustros dias libres gracias")).toBe(true);
    expect(isFarewell("no puedo esos dias, gracias")).toBe(true);
  });
  it("'no' + despedida directa es cierre", () => {
    expect(isFarewell("No, hasta luego")).toBe(true);
    expect(isFarewell("no, adios")).toBe(true);
  });
  it("una negación con contenido SUSTANTIVO (no es un cierre) sigue sin matchear", () => {
    expect(isFarewell("no tengo tarjeta, solo efectivo")).toBe(false);
    expect(isFarewell("no me llegó la ubicación")).toBe(false);
  });
});

describe("isEventInquiry — eventos (Valle de Ángeles) vs estadías (ads Jacarí eventos, 9-jul-2026)", () => {
  it("Valle de Ángeles nombrado SIEMPRE es evento (con y sin acentos)", () => {
    expect(mentionsValleDeAngeles("Vi su anuncio de Valle de Ángeles")).toBe(true);
    expect(mentionsValleDeAngeles("info del espacio en valle de angeles")).toBe(true);
    expect(isEventInquiry("Vi su anuncio de Valle de Ángeles y quiero más información")).toBe(true);
  });
  it("tipos de evento FUERTES disparan sin nombrar el venue", () => {
    expect(isEventInquiry("Quiero información para una boda")).toBe(true);
    expect(isEventInquiry("hacen eventos corporativos?")).toBe(true);
    expect(isEventInquiry("precio para un bautizo")).toBe(true);
    expect(isEventInquiry("es para una quinceañera")).toBe(true);
    expect(isEventInquiry("do you host weddings?")).toBe(true);
  });
  it("palabras DÉBILES necesitan contexto de venue — 'cumpleaños' suelto NO desvía", () => {
    expect(isEventInquiry("busco un salón para un cumpleaños")).toBe(true);
    expect(isEventInquiry("alquilan para eventos?")).toBe(true);
    expect(isEventInquiry("tienen local para eventos?")).toBe(true);
    expect(isEventInquiry("es el cumpleaños de mi esposa")).toBe(false);
    expect(isEventInquiry("venimos a celebrar")).toBe(false);
  });
  it("señal de ALOJAMIENTO nuestro gana → una estadía con celebración NO es evento", () => {
    expect(isEventInquiry("queremos Casa Brisa para el cumpleaños de mi mamá, somos 6")).toBe(false);
    expect(isEventInquiry("una casa en Tela para celebrar un cumpleaños")).toBe(false);
    expect(isEventInquiry("casa en La Ceiba para una boda")).toBe(false);
  });
  it("la regla del handoff es terminal (sin followups ni falso 'bot mudo')", () => {
    expect(TERMINAL_RULES.has("event_inquiry_handoff")).toBe(true);
  });
});

describe("detectPackageInquiry — Family pack / Love Trip / Friends Trip (ads 9-jul-2026)", () => {
  it("nombre del paquete dispara directo", () => {
    expect(detectPackageInquiry("quiero info del Family Pack")).toBe("family_pack");
    expect(detectPackageInquiry("me interesa el Love Trip")).toBe("love_trip");
    expect(detectPackageInquiry("hacen el Friends Trip?")).toBe("friends_trip");
  });
  it("patrón real del anuncio: 'oferta de <ciudad>' sin nombrar el paquete (caso Karen López, 10-jul-2026)", () => {
    expect(detectPackageInquiry("¡Hola! 👋 Quiero más información sobre la oferta de Tela, Atlántida de L. 6,700")).toBe("friends_trip");
    expect(detectPackageInquiry("quiero información sobre la oferta de La Ceiba de L. 5,400")).toBe("family_pack");
  });
  it("mención de ciudad SIN 'oferta' no dispara (no todo mensaje de Tela es un paquete)", () => {
    expect(detectPackageInquiry("quiero ir a Tela con mi familia")).toBeNull();
  });
});

// 🐛 CASO REAL — DVALL (+504 9963-0648), 11-jul-2026. Entró por el anuncio
// "oferta de Tela, Atlántida de L. 6,700" (turno 1, pre-deploy del gate de
// paquetes) y al día siguiente preguntó "Buen día 6,700 cuantas personas":
// solo el PRECIO, sin "oferta" ni ciudad ni nombre del paquete →
// detectPackageInquiry=null → el turno cayó al LLM, que NEGÓ la oferta
// ("La tarifa de L. 6,700 no corresponde a nuestras propiedades") porque su
// prompt solo conoce la tarifa por noche. El precio del anuncio ES el
// identificador del paquete.
describe("detectPackageByAdPrice — el precio del anuncio pelado identifica el paquete (caso DVALL, 11-jul-2026)", () => {
  it("el mensaje REAL de DVALL dispara friends_trip (solo el monto, nada más)", () => {
    expect(detectPackageByAdPrice("Buen día 6,700 cuantas personas", null)).toBe("friends_trip");
  });
  it("variantes de formato del monto (con L., punto de miles, sin separador) y el precio entre-semana 6,300", () => {
    expect(detectPackageByAdPrice("info de la promo de 6700", null)).toBe("friends_trip");
    expect(detectPackageByAdPrice("¿sigue la de L. 6.700?", null)).toBe("friends_trip");
    expect(detectPackageByAdPrice("vi una de 6,300 entre semana", null)).toBe("friends_trip");
    expect(detectPackageByAdPrice("la oferta de 5,400 de la villa", null)).toBe("family_pack");
  });
  it("guard anti-eco: con una propiedad YA fijada, el monto es eco de una cotización, no el anuncio (Morazán 3 noches = 2100×3+400 = 6,700 exactos)", () => {
    expect(detectPackageByAdPrice("¿el total era 6,700 verdad?", "centro-morazan")).toBeNull();
    expect(detectPackageByAdPrice("Buen día 6,700 cuantas personas", "casa-marea")).toBeNull();
  });
  it("no matchea montos ajenos ni números incrustados en otros", () => {
    expect(detectPackageByAdPrice("somos 6 personas", null)).toBeNull();
    expect(detectPackageByAdPrice("llegamos a las 6:30", null)).toBeNull();
    expect(detectPackageByAdPrice("el total 16,700 me parece caro", null)).toBeNull();
    expect(detectPackageByAdPrice("tengo presupuesto de 7,000", null)).toBeNull();
    expect(detectPackageByAdPrice("mi número termina en 0648", null)).toBeNull();
  });
});

describe("isAvailabilityDatesRequest — pregunta INVERSA de disponibilidad (bug Carlos Meza, 10-jul-2026)", () => {
  it("los mensajes EXACTOS de Carlos disparan (pide que NOSOTROS propongamos fechas)", () => {
    // Turno 12 y 14 del chat real, Villa B11. "b11" NO cuenta como fecha concreta.
    expect(isAvailabilityDatesRequest("Y que fecha si tienes disponible para villa B11?")).toBe(true);
    expect(isAvailabilityDatesRequest("Dame fechas que tengas disponibles en Villa B11!")).toBe(true);
  });

  it("otras formas de la pregunta inversa (es/en)", () => {
    expect(isAvailabilityDatesRequest("¿qué fechas tienen disponibles?")).toBe(true);
    expect(isAvailabilityDatesRequest("cuáles días están libres")).toBe(true);
    expect(isAvailabilityDatesRequest("decime las fechas que tengas libres")).toBe(true);
    expect(isAvailabilityDatesRequest("fechas disponibles?")).toBe(true);
    expect(isAvailabilityDatesRequest("¿cuándo está disponible?")).toBe(true);
    expect(isAvailabilityDatesRequest("what dates do you have available?")).toBe(true);
    expect(isAvailabilityDatesRequest("which days are free")).toBe(true);
  });

  it("un chequeo con fecha CONCRETA NO es la pregunta inversa → va al cotizador real", () => {
    // Trae rango/día → el guard lo descarta (debe cotizarse, no reformular).
    expect(isAvailabilityDatesRequest("¿está disponible del 13 al 17 de julio?")).toBe(false);
    expect(isAvailabilityDatesRequest("hay disponibilidad para el 20 de julio")).toBe(false);
    expect(isAvailabilityDatesRequest("tienen libre el 15?")).toBe(false);
    expect(isAvailabilityDatesRequest("Tienes disponibilidad en la semana del 13 al 17 de julio?")).toBe(false);
  });

  it("NO se confunde con preguntas que no son de disponibilidad de fechas", () => {
    expect(isAvailabilityDatesRequest("¿qué día es el check-in?")).toBe(false);
    expect(isAvailabilityDatesRequest("¿a qué hora puedo entrar?")).toBe(false);
    expect(isAvailabilityDatesRequest("¿cuándo puedo hacer el check in?")).toBe(false);
    expect(isAvailabilityDatesRequest("Villa B11")).toBe(false);
    expect(isAvailabilityDatesRequest("somos 6 personas")).toBe(false);
    expect(isAvailabilityDatesRequest("¿qué precio tiene?")).toBe(false);
  });
});

describe("isCapacityQuestion — pregunta por el CUPO, no headcount propio (bug Méndez, 11-jul-2026)", () => {
  it("reconoce la pregunta de capacidad en varias formas (es/en)", () => {
    expect(isCapacityQuestion("Hasta cuanto es la capacidad de adultos")).toBe(true);
    expect(isCapacityQuestion("¿cuál es la capacidad?")).toBe(true);
    expect(isCapacityQuestion("cuántas personas caben")).toBe(true);
    expect(isCapacityQuestion("para cuántas personas es")).toBe(true);
    expect(isCapacityQuestion("cupo máximo?")).toBe(true);
    expect(isCapacityQuestion("¿cuántos huéspedes admite?")).toBe(true);
    expect(isCapacityQuestion("what's the capacity?")).toBe(true);
    expect(isCapacityQuestion("how many people fit?")).toBe(true);
    expect(isCapacityQuestion("max guests?")).toBe(true);
  });
  it("NO confunde el headcount propio del cliente con una pregunta de cupo", () => {
    expect(isCapacityQuestion("Somos 4 adultos u una bb")).toBe(false);
    expect(isCapacityQuestion("3 adultos ubs bb")).toBe(false);
    expect(isCapacityQuestion("4 adultos")).toBe(false);
    expect(isCapacityQuestion("si quiero")).toBe(false);
    expect(isCapacityQuestion("cuántas noches")).toBe(false);
    expect(isCapacityQuestion("cuánto cuesta")).toBe(false);
  });
  it("headcount + pregunta explícita de cupo SÍ dispara ('somos 5 personas, ¿caben?')", () => {
    // El guard no suprime cuando hay una pregunta real de caber; pero exige señal de
    // cupo (personas/cuántos/caber) — un "¿entran?"/"¿aceptan?" pelado NO alcanza, para
    // no pisar horario de entrada ni política de mascotas.
    expect(isCapacityQuestion("somos 5 personas, ¿caben?")).toBe(true);
  });
});
