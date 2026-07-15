import { describe, it, expect } from "vitest";
import {
  isConfirmation,
  isAvailabilityDatesRequest,
  isCapacityQuestion,
  isBeachProximityQuestion,
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
  isTotalConfirmationQuestion,
  extractStayDayPair,
  isHumanAgentRequested,
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
  it("OBJECIÓN/lamento con 'si' incidental NO confirma (caso +504 9583-9796, 13-jul-2026)", () => {
    // El "si" es conjunción ("sentimos que SI nos ubicamos"), no "sí". El cliente objeta
    // la capacidad; el bot lo tomó como confirmación y saltó a cobrar → bucle de pago.
    expect(isConfirmation("Nos gusta más la villa y sentimos que si nos ubicamos bien pero lastima que ud tiene ese límite, porque los niños que llevamos son pequeños, es mucho alquilar dos casa realmente")).toBe(false);
    expect(isConfirmation("es mucho alquilar dos casas realmente")).toBe(false);
    expect(isConfirmation("nos gusta pero es mucho el espacio para nosotros")).toBe(false);
    expect(isConfirmation("lástima que tiene ese límite de personas")).toBe(false);
  });
  it("una objeción con un 'sí' FUERTE sí confirma (el guard no se pasa de listo)", () => {
    // Si el cliente objeta PERO igual dice un sí fuerte, es una confirmación real.
    expect(isConfirmation("sí, aunque es un poco caro, dale")).toBe(true);
    expect(isConfirmation("perfecto, me gusta pero quiero reservar")).toBe(true);
  });
});

describe("isHumanAgentRequested — pide una persona / se frustra (caso +504 9583-9796, 13-jul-2026)", () => {
  it("pedir un humano dispara (en cualquier estado escala + pausa)", () => {
    expect(isHumanAgentRequested("si me atiende una persona me gustaría para que realmente lean mis mensajes")).toBe(true);
    expect(isHumanAgentRequested("quiero hablar con una persona")).toBe(true);
    expect(isHumanAgentRequested("me pueden comunicar con un agente")).toBe(true);
    expect(isHumanAgentRequested("prefiero atención personal")).toBe(true);
  });
  it("'no leen mis mensajes' / 'esto es un bot' también (misma respuesta: un humano)", () => {
    expect(isHumanAgentRequested("Creo que no leen los mensajes")).toBe(true);
    expect(isHumanAgentRequested("esto es un bot?")).toBe(true);
  });
  it("NO dispara con chatter normal de reserva (sin falsos positivos)", () => {
    expect(isHumanAgentRequested("quiero reservar la villa")).toBe(false);
    expect(isHumanAgentRequested("a qué hora es el check in?")).toBe(false);
    expect(isHumanAgentRequested("las casas están conectadas?")).toBe(false);
    expect(isHumanAgentRequested("me pasás las fotos?")).toBe(false);
    expect(isHumanAgentRequested("sí, dale, transferencia")).toBe(false);
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
  // El botón "Ya no, gracias" del template de followup (B4) llega como texto —
  // debe reconocerse como cierre (antes "ya no, gracias" con coma no matcheaba).
  it("'ya no, gracias' (botón opt-out del followup) es cierre, con o sin coma", () => {
    expect(isFarewell("Ya no, gracias")).toBe(true);
    expect(isFarewell("ya no gracias")).toBe(true);
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

describe("isBeachProximityQuestion — proximidad al mar/playa (croquis de Tela, 13-jul-2026)", () => {
  it("detecta la pregunta de PROXIMIDAD/DISTANCIA al mar/playa (es/en)", () => {
    expect(isBeachProximityQuestion("¿está cerca del mar?")).toBe(true);
    expect(isBeachProximityQuestion("la playa queda cerca?")).toBe(true);
    expect(isBeachProximityQuestion("¿a cuánto queda la playa?")).toBe(true);
    expect(isBeachProximityQuestion("se puede ir caminando a la playa?")).toBe(true);
    expect(isBeachProximityQuestion("¿a cuántos minutos está el mar?")).toBe(true);
    expect(isBeachProximityQuestion("qué tan lejos está la playa")).toBe(true);
    expect(isBeachProximityQuestion("¿es frente al mar?")).toBe(true);
    expect(isBeachProximityQuestion("how far is the beach?")).toBe(true);
    expect(isBeachProximityQuestion("is it close to the sea?")).toBe(true);
    expect(isBeachProximityQuestion("is it walking distance to the beach?")).toBe(true);
    expect(isBeachProximityQuestion("is it beachfront?")).toBe(true);
  });
  it("NO dispara con la amenidad '¿tiene playa?' (sin proximidad) — esa la responde la KB", () => {
    expect(isBeachProximityQuestion("¿tiene playa?")).toBe(false);
    expect(isBeachProximityQuestion("hay playa?")).toBe(false);
    expect(isBeachProximityQuestion("tiene acceso a la playa?")).toBe(false);
  });
  it("NO se confunde con proximidad a OTRA cosa (sin mar/playa) ni con 'Casa Marea'", () => {
    expect(isBeachProximityQuestion("¿está cerca del centro?")).toBe(false);
    expect(isBeachProximityQuestion("queda lejos del aeropuerto?")).toBe(false);
    expect(isBeachProximityQuestion("Casa Marea está disponible?")).toBe(false);
    expect(isBeachProximityQuestion("¿cuántas cuadras al supermercado?")).toBe(false);
  });
});

describe("isTotalConfirmationQuestion — pregunta del TOTAL con la plata en la mano (caso +504 9583-9796, 13-jul-2026)", () => {
  it("reconoce la pregunta/confirmación del total (es/en) — incluye los 2 mensajes REALES del chat", () => {
    // Los dos mensajes reales que el bot se tragó con transfer_ask_proof verbatim:
    expect(isTotalConfirmationQuestion("Perfecto , ese es el total por las 2 noches  y 3 días  verdad ?")).toBe(true);
    expect(isTotalConfirmationQuestion("Haaa OK perfecto y ahí cuanto seria el total a pagar en las fechas que necesito?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿ese es el total?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿cuál sería el precio final?")).toBe(true);
    expect(isTotalConfirmationQuestion("el depósito es el total?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿eso es todo lo que pago?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿ya incluye la limpieza?")).toBe(true);
    expect(isTotalConfirmationQuestion("es con todo incluido?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿cuánto falta por pagar?")).toBe(true);
    expect(isTotalConfirmationQuestion("is that the total for the 2 nights?")).toBe(true);
    expect(isTotalConfirmationQuestion("what's the total?")).toBe(true);
    expect(isTotalConfirmationQuestion("does it include everything?")).toBe(true);
  });
  it("NO confunde 'total' de PERSONAS (headcount) ni el reporte de pago ya hecho", () => {
    expect(isTotalConfirmationQuestion("en total somos 6 personas")).toBe(false);
    expect(isTotalConfirmationQuestion("somos 8 en total")).toBe(false);
    expect(isTotalConfirmationQuestion("el total de adultos sería 6")).toBe(false);
    expect(isTotalConfirmationQuestion("ya pagué el total")).toBe(false);
    expect(isTotalConfirmationQuestion("ya transferí el total de 5,350")).toBe(false);
    expect(isTotalConfirmationQuestion("Transferencia")).toBe(false);
    expect(isTotalConfirmationQuestion("Sería entrar el 17 y salida el 19")).toBe(false);
    expect(isTotalConfirmationQuestion("ok perfecto")).toBe(false);
  });
  it("la PREGUNTA le gana al reporte de pago cuando vienen juntos (hallazgo adversario)", () => {
    // El escenario EXACTO de la confusión del depósito: transfirió y pregunta si era el total.
    expect(isTotalConfirmationQuestion("Ya transferí, ¿ese es el total verdad?")).toBe(true);
    expect(isTotalConfirmationQuestion("Ya pagué el depósito, ¿cuánto falta por pagar?")).toBe(true);
    expect(isTotalConfirmationQuestion("Ya hice la transferencia, ¿ese era el total?")).toBe(true);
  });
  it("pregunta de plata que MENCIONA al grupo SÍ dispara (el guard de headcount es estrecho)", () => {
    expect(isTotalConfirmationQuestion("¿Cuánto sería el total por las 6 personas?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿cuánto es el total para 6 personas?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿El total incluye a los niños?")).toBe(true);
  });
  it("formas hondureñas comunes del total (hallazgo adversario)", () => {
    expect(isTotalConfirmationQuestion("¿Cuánto le debo?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿Cuánto tengo que pagar?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿En cuánto me sale todo?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿El total es 5,350?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿Son 5,350 en total?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿Y el total cuánto sería?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿me confirma el total?")).toBe(true);
    expect(isTotalConfirmationQuestion("¿Con la transferencia queda cancelado el total?")).toBe(true);
  });
  it("'incluye todo <cosa>' es AMENIDAD, no plata (hallazgo adversario)", () => {
    expect(isTotalConfirmationQuestion("¿Incluye todo el equipo de cocina?")).toBe(false);
    expect(isTotalConfirmationQuestion("¿incluye todo lo de la piscina?")).toBe(false);
    expect(isTotalConfirmationQuestion("¿ya incluye todo?")).toBe(true);
  });
});

describe("extractStayDayPair — par de días entrada/salida SIN mes (caso +504 9583-9796, 13-jul-2026)", () => {
  const pair = (inDay: number, outDay: number, inMonth: number | null = null, outMonth: number | null = null) =>
    ({ inDay, outDay, inMonth, outMonth });
  it("extrae el par de días de las formas reales del chat (es/en)", () => {
    // Los dos mensajes reales:
    expect(extractStayDayPair("Sería entrar el 17 y salida el 19")).toEqual(pair(17, 19));
    expect(extractStayDayPair("Del 17 al 19")).toEqual(pair(17, 19));
    expect(extractStayDayPair("del 20 al 22")).toEqual(pair(20, 22));
    expect(extractStayDayPair("desde el 17 hasta el 19")).toEqual(pair(17, 19));
    expect(extractStayDayPair("entre el 3 y el 5")).toEqual(pair(3, 5));
    expect(extractStayDayPair("llegamos el 17 y nos vamos el 19")).toEqual(pair(17, 19));
    expect(extractStayDayPair("entrada el 24 y salida el 26")).toEqual(pair(24, 26));
    expect(extractStayDayPair("from the 17th to the 19th")).toEqual(pair(17, 19));
    // Cruce de mes ("del 30 al 2") es válido — la comparación contra el estado decide.
    expect(extractStayDayPair("del 30 al 2")).toEqual(pair(30, 2));
  });
  it("el MES explícito se captura para cotejarlo contra el estado (hallazgo adversario)", () => {
    // "¿del 17 al 19 de octubre?" con reserva en julio NO puede dar "¡Confirmado!".
    expect(extractStayDayPair("del 17 de julio al 19")).toEqual(pair(17, 19, 7, null));
    expect(extractStayDayPair("del 17 al 19 de octubre")).toEqual(pair(17, 19, null, 10));
    expect(extractStayDayPair("del 17 de julio al 19 de julio")).toEqual(pair(17, 19, 7, 7));
  });
  it("la HORA anula por NÚMERO, no por span (hallazgos adversarios)", () => {
    // Horarios de check-in/out — jamás son un par de días:
    expect(extractStayDayPair("entramos a las 3 y salimos a las 11")).toBe(null);
    expect(extractStayDayPair("entrada a las 3 y salida a las 11, ¿verdad?")).toBe(null);
    expect(extractStayDayPair("¿el check in es a las 3 y el check out a las 11?")).toBe(null);
    // …pero fechas + hora de llegada en el mismo mensaje SÍ dan el par:
    expect(extractStayDayPair("Llegamos el 17 como a las 3 pm y salimos el 19")).toEqual(pair(17, 19));
    expect(extractStayDayPair("entre el 3 y el 5 de la tarde")).toBe(null);
    expect(extractStayDayPair("¿hay descuento del 10 al 15 por ciento?")).toBe(null);
  });
  it("NO extrae horas, headcount, edades ni números sueltos", () => {
    expect(extractStayDayPair("de 3 a 5 pm")).toBe(null);
    expect(extractStayDayPair("del 2 al 4 pm")).toBe(null);
    expect(extractStayDayPair("de 17 a 19 personas")).toBe(null);
    expect(extractStayDayPair("entre el 15 y el 17 huéspedes")).toBe(null);
    expect(extractStayDayPair("somos 6 personas")).toBe(null);
    expect(extractStayDayPair("el 17")).toBe(null);
    expect(extractStayDayPair("llegamos como a las 3")).toBe(null);
    expect(extractStayDayPair("del 17 al 17")).toBe(null);
    expect(extractStayDayPair("del 45 al 50")).toBe(null);
    expect(extractStayDayPair("Transferencia")).toBe(null);
  });
});
