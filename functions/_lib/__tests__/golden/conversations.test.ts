import { describe, it, expect } from "vitest";
import { resolveDates, extractNights, extractDatePhrases } from "../../date-parser";
import {
  isConfirmation,
  isNotInterested,
  isCheckinTimeRequest,
  isAvailabilityDatesRequest,
  isCapacityQuestion,
  isBeachProximityQuestion,
  isDateChangeOrAvailabilityQuestion,
  isBankAccountRequest,
  isLegitimacyQuestion,
  isPostponing,
  isFarewell,
  isBareAck,
  indicatesNotDoneYet,
  isPhoneNumberRequest,
  isCallRequested,
  isLocationRequest,
  isPhotoRequest,
  isBedroomPhotoRequest,
  isPaymentReported,
  isCardChoice,
  isTransferChoice,
  isLongTermRequest,
  nightsBetween,
  LONG_TERM_NIGHTS,
  cityFromText,
  hasInScopeSignal,
  isUnverifiedQuoteClaim,
  isEventInquiry,
  mentionsValleDeAngeles,
  detectPackageInquiry,
  detectPackageByAdPrice,
  TERMINAL_RULES,
} from "../../detectors";
import { normalizePhone } from "../../phone";
import { T } from "../../i18n";
import { PROPERTY_PRICING, computeDayPassHNL } from "../../quote-builder";
import { getBedroomPhotos, TELA_CROQUIS_URL } from "../../property-photos";
import { locationFromText, isEventInquiryTurn2, gemelasOverSized } from "../../quote-flow";
import { fechaEnPalabras } from "../../conversational-bot";
import { extractPartySize, partyHeadcount, mergeFriendsTripParty } from "../../party-size";
import { findAlternativeDates, formatWindowHuman } from "../../suggest-dates";

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
// Patrones SIN invariante unitario (viven en el flujo/crons/LLM, se validan e2e):
// bot mudo total (proveedor), círculo vicioso del cron, inventó zona/cama (prompt),
// repitió pregunta (memoria LLM), followups del cron (SQL), spam sin sentido,
// bienvenida con relleno, sobreafirmación de categoría, gemelas para 25 (prompt).
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
  it("el prompt recibe 'hoy' EN PALABRAS (junio vs julio se compara por nombre)", () => {
    // Fix 9bc0a87: el LLM compara meses mal en ISO; se le da "domingo 14 de junio de 2026".
    expect(fechaEnPalabras("2026-06-14")).toBe("domingo 14 de junio de 2026");
    expect(fechaEnPalabras("2026-07-17")).toContain("julio");
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
  it("'4 adultos y 1 niña' tampoco son noches; '3 noches' explícitas sí", () => {
    expect(extractNights("4 adultos y 1 niña")).toBeNull();
    expect(extractNights("serían 3 noches")).toBe(3);
  });
});

describe("CHAT: Zedileth — 'si estaría disponible' tratado como un 'sí, cobrale'", () => {
  it("la pregunta de disponibilidad no es confirmación", () => {
    expect(isConfirmation("Pero si estaría disponible para el 17 de junio?")).toBe(false);
  });
  it("el cambio de fecha se reconoce → re-cotizar, no cobrar", () => {
    expect(isDateChangeOrAvailabilityQuestion("Pero si estaría disponible para el 17 de junio?")).toBe(true);
    expect(isDateChangeOrAvailabilityQuestion("mejor el 20")).toBe(true);
    expect(isDateChangeOrAvailabilityQuestion("del 20 al 22")).toBe(true);
    expect(isDateChangeOrAvailabilityQuestion("dale confirmo")).toBe(false);
  });
});

describe("CHAT: Sandra — pregunta de horario tragada en el paso de pago", () => {
  it("la pregunta por la hora de entrada se detecta aunque esté eligiendo pago", () => {
    expect(isCheckinTimeRequest("y a qué hora puedo entrar?")).toBe(true);
    expect(isCheckinTimeRequest("cuál es el horario de check in y check out?")).toBe(true);
  });
});

describe("CHAT: Sandra — 'el domingo / el lunes' resueltos al FUTURO, nunca al pasado", () => {
  // Hoy real de ese chat: viernes 12-jun. "el domingo" = 14-jun (próxima ocurrencia).
  const FRIDAY = "2026-06-12";
  it("un día de semana nombrado es la PRÓXIMA ocurrencia desde hoy", () => {
    const r = resolveDates("viajar sería el domingo", null, null, FRIDAY);
    expect(r.checkIn).toBe("2026-06-14");
    expect(r.checkIn! >= FRIDAY).toBe(true);
  });
  it("si hoy ES ese día, va a la semana siguiente (no hoy-ambiguo, no pasado)", () => {
    const r = resolveDates("llegamos el lunes", null, null, TODAY); // TODAY es lunes
    expect(r.checkIn).toBe("2026-06-22");
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

describe("CHAT: Eduardo — el bot inventó un número de cuenta bancaria", () => {
  it("pedir la cuenta se intercepta ANTES del LLM (los datos salen de bank-transfer.ts)", () => {
    expect(isBankAccountRequest("a qué cuenta transfiero?")).toBe(true);
    expect(isBankAccountRequest("me pasás los datos bancarios?")).toBe(true);
    expect(isBankAccountRequest("dónde deposito?")).toBe(true);
  });
  it("NO roba 'número de personas'", () => {
    expect(isBankAccountRequest("cuál es el número de personas máximo?")).toBe(false);
  });
});

describe("CHAT: Vanina — 142 noches cotizadas como reserva por noche", () => {
  it("el pedido explícito de largo plazo se detecta → escala, no cotiza", () => {
    expect(isLongTermRequest("busco algo a largo plazo, serían varios meses")).toBe(true);
    expect(isLongTermRequest("alquiler mensual")).toBe(true);
    expect(isLongTermRequest("quiero 2 noches en Tela")).toBe(false);
  });
  it("11 jul → 30 nov son 142 noches y supera el umbral de largo plazo", () => {
    const nights = nightsBetween("2026-07-11", "2026-11-30");
    expect(nights).toBe(142);
    expect(nights >= LONG_TERM_NIGHTS).toBe(true);
  });
});

describe("CHAT: Yosmary — 'le confirmaría la otra semana' recibió una despedida genérica", () => {
  it("postergar la confirmación se detecta (→ recordar que las fechas se apartan con depósito)", () => {
    expect(isPostponing("Le confirmaría la otra semana")).toBe(true);
    expect(isPostponing("lo consulto y te aviso después")).toBe(true);
  });
  it("'quiero reservar la otra semana' NO es postergación (es una reserva)", () => {
    expect(isPostponing("quiero reservar la otra semana")).toBe(false);
  });
  it("el 'Sii' de acuse posterior se reconoce (para silenciarlo tras el cierre)", () => {
    expect(isBareAck("Sii")).toBe(true);
  });
});

describe("CHAT: Franci — repitió la MISMA despedida ante cada 'ok'", () => {
  it("los cierres claros del cliente se detectan (una sola despedida, después silencio)", () => {
    expect(isFarewell("Ya no gracias")).toBe(true);
    expect(isFarewell("no, gracias")).toBe(true);
    expect(isFarewell("muchas gracias!")).toBe(true);
  });
  it("los acuses mínimos se detectan ('ok', '👍')", () => {
    expect(isBareAck("ok")).toBe(true);
    expect(isBareAck("👍")).toBe(true);
  });
  it("un mensaje con contenido real NO es despedida ni acuse", () => {
    expect(isFarewell("gracias, y cómo pago?")).toBe(false);
    expect(isBareAck("ok pero antes quiero ver fotos")).toBe(false);
  });
});

describe("CHAT: Emilio — preguntó si era estafa y el bot repitió 'mandame el comprobante' 4×", () => {
  it("la duda de legitimidad se detecta en CUALQUIER estado (incluso esperando comprobante)", () => {
    expect(isLegitimacyQuestion("son reales verdad")).toBe(true);
    expect(isLegitimacyQuestion("como puedo hacer para confirmar su veracidad")).toBe(true);
    expect(isLegitimacyQuestion("es seguro pagar así?")).toBe(true);
  });
  it("NO roba el pedido de cuenta (eso es isBankAccountRequest)", () => {
    expect(isLegitimacyQuestion("a qué cuenta transfiero?")).toBe(false);
  });
});

describe("CHAT: Princesa de Altar — 'Ya no muchas gracias' → el bot pidió pagar", () => {
  it("una negación gana aunque el mensaje traiga 'ya'/'ok'/'listo'", () => {
    expect(isConfirmation("Ya no muchas gracias")).toBe(false);
    expect(isConfirmation("ok no gracias")).toBe(false);
    expect(isConfirmation("mejor no, gracias")).toBe(false);
  });
  it("las confirmaciones reales siguen pasando", () => {
    expect(isConfirmation("dale, confirmo")).toBe(true);
    expect(isConfirmation("sí perfecto")).toBe(true);
  });
});

describe("CHAT: lead 13-jun — 'Ok buen día' (despedida) tratado como 'sí, cobrale'", () => {
  it("despedida con 'ok' débil cierra; despedida con 'sí' fuerte confirma", () => {
    expect(isConfirmation("Ok buen día")).toBe(false);
    expect(isConfirmation("perfecto, buen día")).toBe(true);
  });
});

describe("CHAT: lead 13-jun — rechazó 3 veces y el bot repetía 'elegí una opción'", () => {
  it("el rechazo se detecta también dentro del paso de pago", () => {
    expect(isNotInterested("No le e pedido ninguna reserva")).toBe(true);
    expect(isNotInterested("era muy caro")).toBe(true);
    expect(isNotInterested("se me va del presupuesto")).toBe(true);
  });
});

describe("CHAT: Efrain — dijo 'No' y el bot respondió 'Recibí tu comprobante'", () => {
  it("negación/postergación esperando comprobante NO es un comprobante", () => {
    expect(indicatesNotDoneYet("No")).toBe(true);
    expect(indicatesNotDoneYet("todavía no")).toBe(true);
    expect(indicatesNotDoneYet("primero se valida con la familia")).toBe(true);
  });
  it("reportar el pago hecho sí se reconoce (→ escalar a verificar)", () => {
    expect(isPaymentReported("ya pagué")).toBe(true);
    expect(isPaymentReported("ya transferí")).toBe(true);
  });
});

describe("CHAT: Carlos Pineda — pidió un teléfono y el bot recitó las ciudades", () => {
  it("pedir un número de contacto se responde directo (no es out_of_scope)", () => {
    expect(isPhoneNumberRequest("ocupo un número de teléfono")).toBe(true);
    expect(isPhoneNumberRequest("tienen teléfono?")).toBe(true);
  });
  it("no se confunde con 'número de cuenta' ni con pedir que LO llamen", () => {
    expect(isPhoneNumberRequest("número de cuenta")).toBe(false);
    expect(isCallRequested("me pueden llamar?")).toBe(true);
  });
});

describe("CHAT: Yosmary — pidió la ubicación 3 veces y el bot la esquivó", () => {
  it("el pedido de ubicación se detecta", () => {
    expect(isLocationRequest("me puede mandar la ubicación?")).toBe(true);
    expect(isLocationRequest("dónde queda exactamente?")).toBe(true);
    expect(isLocationRequest("me pasás el mapa?")).toBe(true);
  });
});

describe("CHAT: contexto Morazán + 'ubicación de Tela' — mandó el mapa equivocado", () => {
  it("la zona nombrada EN el mensaje gana sobre el contexto", () => {
    expect(locationFromText("me pasás la ubicación de tela?")).toContain("maps.app.goo.gl");
    expect(locationFromText("la de centro morazán")).toBe("https://maps.app.goo.gl/KwBr1PAt79UyNogU6");
    expect(locationFromText("ubicación de tela")).not.toBe(locationFromText("la de centro morazán"));
  });
  it("Tegucigalpa NO se auto-resuelve (3 casas distintas → el bot pregunta cuál)", () => {
    expect(locationFromText("ubicación de tegucigalpa")).toBeUndefined();
  });
});

describe("CHAT: Natalia — pidió 'sus redes sociales para ver el lugar' y el bot escaló", () => {
  it("pedir redes/Instagram para ver el lugar es un pedido de FOTOS, no out_of_scope", () => {
    expect(isPhotoRequest("me regala sus redes sociales para ver el lugar")).toBe(true);
    expect(isPhotoRequest("tienen instagram?")).toBe(true);
  });
});

describe("CHAT: Menchaca — pidió fotos eligiendo el pago y el bot repetía 'elegí una opción'", () => {
  it("el pedido de fotos se detecta también durante el pago", () => {
    expect(isPhotoRequest("quiero ver fotos de la casa antes de pagar")).toBe(true);
  });
});

describe("CHAT: Villa B11 14-jun — pidió HABITACIONES y recibió la sala", () => {
  it("el pedido de dormitorios se distingue (incluye el typo 'abitaciones')", () => {
    expect(isBedroomPhotoRequest("Fotos de las habitaciones")).toBe(true);
    expect(isBedroomPhotoRequest("me muestra las abitaciones?")).toBe(true);
    expect(isBedroomPhotoRequest("fotos de la casa")).toBe(false);
  });
  it("las gemelas de Tela tienen fotos de dormitorios curadas", () => {
    expect(getBedroomPhotos("casa-brisa").length).toBeGreaterThan(0);
  });
});

describe("CHAT: grupo de 13 en Tela — el bot ofrecía 'las gemelas' pero no podía cotizarlas", () => {
  it("existe el producto las-gemelas-tela con capacidad 12", () => {
    const gemelas = PROPERTY_PRICING["las-gemelas-tela"];
    expect(gemelas).toBeDefined();
    expect(gemelas.capacity).toBe(12);
  });
  it("las casas individuales de Tela siguen con capacidad 6", () => {
    expect(PROPERTY_PRICING["casa-brisa"].capacity).toBe(6);
    expect(PROPERTY_PRICING["casa-marea"].capacity).toBe(6);
  });
});

describe("CHAT: Giampaolo (+39 Italia) — el número quedó corrupto y nada le llegaba", () => {
  it("un entrante de Meta NUNCA recibe 504 antepuesto", () => {
    expect(normalizePhone("393331234567", { assumeAlreadyE164: true }).e164).toBe("393331234567");
  });
  it("un número local de 8 dígitos sí se completa a 504", () => {
    expect(normalizePhone("88390145").e164).toBe("50488390145");
  });
});

describe("CHAT: Franci — el 'último aviso' llevaba 🌴 en Tegucigalpa", () => {
  it("🌴 solo en propiedades de playa", () => {
    expect(T.lastCallAlive("es", " en Tegucigalpa", false)).not.toContain("🌴");
    expect(T.lastCallAlive("es", " con Casa Brisa", true)).toContain("🌴");
  });
});

describe("CHAT: Jflores — 'para hoy' sin salida → 'voy a verificar…' y nunca volvió", () => {
  it("'para hoy' da la llegada pero NO fabrica salida (el bot debe PEDIRLA)", () => {
    const r = resolveDates("para hoy, 2 personas", null, null, TODAY);
    expect(r.checkIn).toBe(TODAY);
    expect(r.checkOut).toBeNull();
    expect(r.nights).toBeNull();
  });
});

describe("CHAT: Alisson — 11 personas + 'Ceiba' → 'no contamos con esa opción' ×3", () => {
  // 7-jul-2026: "desde Tegucigalpa, son 10 adultos 1 niño, del 7 al 9 de agosto" y
  // luego "Ceiba" (dos veces) terminaron en out_of_scope_redirect, texto idéntico.
  const HOY = "2026-07-07";
  it("una ciudad NUESTRA nombrada en el texto se detecta SIN LLM", () => {
    expect(cityFromText("Ceiba")).toBe("La Ceiba");
    expect(cityFromText("desde Tegucigalpa, son 10 adultos 1 niño")).toBe("Tegucigalpa");
    expect(cityFromText("Tela")).toBe("Tela");
    expect(cityFromText("vamos para la ceiba")).toBe("La Ceiba");
    expect(cityFromText("tegus")).toBe("Tegucigalpa");
  });
  it("sin ciudad nombrada, no inventa una (Roatán y frases sueltas → undefined)", () => {
    expect(cityFromText("busco algo en Roatán")).toBeUndefined();
    expect(cityFromText("quiero la casa más cerca del centro")).toBeUndefined();
    expect(cityFromText("hola buenas noches")).toBeUndefined();
  });
  it("'del 7 al 9 de agosto' en julio resuelve al agosto FUTURO", () => {
    const r = resolveDates("del 7 al 9 de agosto", null, null, HOY);
    expect(r.checkIn).toBe("2026-08-07");
    expect(r.checkOut).toBe("2026-08-09");
  });
  it("'10 adultos 1 niño' jamás produce noches", () => {
    expect(extractNights("son 10 adultos 1 niño")).toBeNull();
  });
  it("el mensaje de grupos 7-12 ofrece las gemelas y menciona el tope 12 (es/en)", () => {
    const es = T.groupRedirectGemelas("es", 11, "La Ceiba");
    expect(es).toContain("Tela");
    expect(es).toContain("12");
    expect(es).toContain("La Ceiba");
    const en = T.groupRedirectGemelas("en", 11, null);
    expect(en).toContain("Tela");
    expect(en).not.toContain("null");
  });
  it("el mensaje de >12 es honesto con el tope y no recita ciudades", () => {
    const es = T.groupTooBig("es");
    expect(es).toContain("12");
    expect(es).not.toContain("Tegucigalpa"); // no es tema de zona
  });
  it("la variante anti-repetición del out_of_scope existe y es distinta al texto base", () => {
    const again = T.outOfScopeAgain("es");
    expect(again.length).toBeGreaterThan(20);
    expect(again).not.toContain("Por ahora nos enfocamos"); // nunca el mismo texto 2×
  });
  it("Ceiba/Tegucigalpa/Tela nombrados SÍ anulan un out_of_scope mal clasificado", () => {
    expect(hasInScopeSignal("Ceiba", null, null, null, null)).toBe(true);
    expect(hasInScopeSignal("desde Tegucigalpa, son 10 adultos 1 niño", null, null, null, null)).toBe(true);
    expect(hasInScopeSignal("Tela", null, null, null, null)).toBe(true);
    // una propiedad ya fijada de un turno previo también cuenta.
    expect(hasInScopeSignal("y para cuántos entra?", null, null, null, "casa-brisa")).toBe(true);
  });
  it("un grupo grande SOLO (sin ciudad/propiedad nuestra) NO fuerza in-scope — regresión del hueco post-fix", () => {
    // Hueco real que vivió unas horas tras el primer fix: "Roatán para 8 personas"
    // tiene un número grande pero NINGUNA ciudad/propiedad nuestra — debe seguir
    // out_of_scope, no terminar preguntando "¿qué propiedad?" para una zona que
    // no tenemos. El número de huéspedes NUNCA alcanza solo.
    expect(hasInScopeSignal("Roatán para 8 personas", null, null, null, null)).toBe(false);
    expect(hasInScopeSignal("somos 11, tienen algo en Copán?", null, null, null, null)).toBe(false);
  });
});

describe("CHAT: Casa Lara fantasma — el LLM 'confirmó' disponibilidad y precio sin cotizador", () => {
  // 16-jun-2026 (+504 3283-4660): con los datos ya completos de turnos previos, el
  // LLM dijo "te confirmo que está disponible... el precio total es de L.3,580"
  // DOS turnos después de que el chequeo REAL había dicho NO disponible. El cron
  // de followup expuso la contradicción 20h después y el lead se perdió.
  // Los strings de abajo son los mensajes EXACTOS de producción.
  it("las afirmaciones reales del caso se detectan (disponibilidad + total + proceder)", () => {
    expect(isUnverifiedQuoteClaim("¡Perfecto! Te confirmo que Casa Lara Townhouse está disponible para tus fechas del 25 al 26 de junio.")).toBe(true);
    expect(isUnverifiedQuoteClaim("¡Genial! Ahora, para proceder con la reserva de Casa Lara Townhouse del 25 al 26 de junio, el precio total es de L.3,580")).toBe(true);
    expect(isUnverifiedQuoteClaim("Déjame verificar el precio total para tu estadía del 25 al 26 de junio en Casa Lara Townhouse.")).toBe(true);
  });
  it("los otros 4 casos reales de 30 días también se detectan", () => {
    expect(isUnverifiedQuoteClaim("¡Perfecto! Te confirmo que el Centro Morazán está disponible para el miércoles 17 de junio")).toBe(true);
    expect(isUnverifiedQuoteClaim("El precio total que te di no incluye el ISV. El ISV en Honduras es del 15%")).toBe(true);
    expect(isUnverifiedQuoteClaim("El precio total para 23 noches en Centro Morazán sería de L.2,100 x 23 = L.48,300")).toBe(true);
  });
  it("un veredicto NEGATIVO improvisado también se verifica (perder ventas por mentira es igual de caro)", () => {
    expect(isUnverifiedQuoteClaim("Lamentablemente esa casa no está disponible ese fin de semana")).toBe(true);
  });
  it("la tarifa POR NOCHE de la ficha es legítima y NO dispara re-cotización", () => {
    // Mensaje real del chat +504 3204-0655 (6-jul), correcto y útil — no debe matchear.
    expect(isUnverifiedQuoteClaim("Las casas en Tela, Casa Brisa y Casa Marea, tienen la misma tarifa: L.2,500 por noche + L.350 de limpieza.")).toBe(false);
    expect(isUnverifiedQuoteClaim("Sí, los L.350 de limpieza son un cargo único que se aplica a la reserva, además de la tarifa por noche. 😊")).toBe(false);
  });
  it("respuestas normales del flujo tampoco matchean", () => {
    expect(isUnverifiedQuoteClaim("¿Para cuántas personas y en qué fechas te gustaría reservar en Tela?")).toBe(false);
    expect(isUnverifiedQuoteClaim("Casa Lara Townhouse está ubicada justo enfrente de la Embajada de EE.UU., a menos de 1 minuto a pie.")).toBe(false);
  });
});

describe("Elección de método de pago (tarjeta vs transferencia)", () => {
  it("tarjeta/PayPal/link → tarjeta", () => {
    expect(isCardChoice("tarjeta")).toBe(true);
    expect(isCardChoice("mejor el link de paypal")).toBe(true);
  });
  it("transferencia/BAC/depósito → transferencia", () => {
    expect(isTransferChoice("transferencia")).toBe(true);
    expect(isTransferChoice("hago el depósito al BAC")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT: Lead de EVENTOS — Valle de Ángeles (ads "Jacarí eventos", 9-jul-2026)
//
// No nace de un fallo sino de una CAPACIDAD nueva: el venue de Valle de Ángeles
// se promociona SOLO para eventos (bodas, cumpleaños, corporativos). El bot no
// cotiza eventos: detecta la consulta, junta tipo + fecha + personas en UNA
// pregunta (event_inquiry_intake) y en el siguiente turno deriva al equipo con
// escalación + pausa (event_inquiry_handoff). El riesgo a blindar es DOBLE:
// (1) un lead de evento cayendo al cotizador de noches u out_of_scope, y
// (2) el detector robándose estadías legítimas que mencionan una celebración.
// ─────────────────────────────────────────────────────────────────────────────
describe("CHAT: Lead de eventos Valle de Ángeles — detección y handoff", () => {
  it("el mensaje prellenado del ad de eventos dispara el flujo de eventos", () => {
    expect(
      isEventInquiry("¡Hola! 👋 Vi su anuncio de Valle de Ángeles y quiero información sobre eventos. 🎉"),
    ).toBe(true);
  });

  it("consultas orgánicas de evento también disparan (sin nombrar el venue)", () => {
    expect(isEventInquiry("Hola, quiero cotizar una boda para 80 personas")).toBe(true);
    expect(isEventInquiry("¿Alquilan el espacio para eventos corporativos?")).toBe(true);
    expect(isEventInquiry("busco un lugar para celebrar un cumpleaños")).toBe(true);
  });

  it("una ESTADÍA que menciona celebración NO se desvía al flujo de eventos", () => {
    // ciudad/propiedad nuestra nombrada = señal de alojamiento → cotizador normal
    expect(isEventInquiry("queremos Casa Brisa para el cumpleaños de mi mamá, somos 6")).toBe(false);
    expect(isEventInquiry("una casa en Tela del 7 al 9 para celebrar un cumple")).toBe(false);
    // "cumpleaños"/"celebrar" sueltos, sin contexto de venue → tampoco
    expect(isEventInquiry("es el cumpleaños de mi esposa")).toBe(false);
  });

  it("Valle de Ángeles nombrado gana SIEMPRE (aun a mitad de otra conversación)", () => {
    expect(mentionsValleDeAngeles("y el lugar de valle de angeles para eventos?")).toBe(true);
    expect(isEventInquiry("y el lugar de valle de angeles?")).toBe(true);
  });

  it("los mensajes del flujo existen en ambos idiomas y piden los 3 datos", () => {
    for (const l of ["es", "en"] as const) {
      expect(T.eventIntake(l)).toContain("1️⃣");
      expect(T.eventIntake(l)).toContain("2️⃣");
      expect(T.eventIntake(l)).toContain("3️⃣");
      expect(T.eventHandoff(l).length).toBeGreaterThan(30);
    }
    expect(T.eventIntake("es")).toContain("Valle de Ángeles");
  });

  it("el handoff es regla TERMINAL: sin followups de cotización ni falso 'bot mudo'", () => {
    expect(TERMINAL_RULES.has("event_inquiry_handoff")).toBe(true);
  });

  // 🐛 CASO REAL — Santi (+504 9389-2082), 9-jul-2026. El bot mandó el intake
  // ("¡Qué emoción! Nuestro espacio en Valle de Ángeles es ideal…") y cuando el
  // cliente respondió "Cumpleaños infantil, octubre, 50 personas", en vez de derivar
  // al equipo se CONTRADIJO con out_of_scope ("no contamos con esa opción"). Causa:
  // una webhook concurrente (un "Hola" casi simultáneo respondido con saludo
  // genérico) pisó el estado `event_inquiry` → el turno 2 no lo encontró, y la
  // respuesta del cliente NO vuelve a disparar isEventInquiry (palabra débil sin
  // contexto de venue). El ancla en la última regla del bot lo salva.
  it("turno 2 con el estado INTACTO deriva al equipo", () => {
    expect(isEventInquiryTurn2("event_inquiry", "")).toBe(true);
  });

  it("turno 2 SOBREVIVE a que se pierda el estado: se ancla en la última regla (bug Santi)", () => {
    // Por qué se perdía: la respuesta al intake no vuelve a ser detectable como evento.
    expect(isEventInquiry("Cumpleaños infantil, octubre, 50 personas")).toBe(false);
    // Red de seguridad: si el intake fue lo último que dijo el bot, sigue siendo turno 2
    // aunque el estado haya quedado en awaiting_quote_data (o se haya borrado).
    expect(isEventInquiryTurn2("awaiting_quote_data", "event_inquiry_intake")).toBe(true);
    expect(isEventInquiryTurn2(undefined, "event_inquiry_intake")).toBe(true);
    expect(isEventInquiryTurn2(null, "event_inquiry_intake")).toBe(true);
  });

  it("NO deriva a eventos si el intake NO fue lo último del bot (no roba estadías)", () => {
    expect(isEventInquiryTurn2("awaiting_quote_data", "quote_provided")).toBe(false);
    expect(isEventInquiryTurn2("quote_provided", "quote_provided")).toBe(false);
    expect(isEventInquiryTurn2(undefined, "")).toBe(false);
  });

  // 🐛 CASO REAL — Yolany Flores (+504 9747-9180), 9-jul-2026. MISMA clase que
  // Santi pero con una arista que su caso NO cubre: Yolany respondió al intake de
  // forma INCREMENTAL y con una KEYWORD FUERTE ("Boda civil"), no con los 3 datos
  // juntos. Resultado en el chat viejo: el bot REPITIÓ el intake verbatim (turno 6)
  // y luego se contradijo con out_of_scope al "70 personas" (turno 8). La trampa:
  // "Boda civil" es isEventInquiry=TRUE → si el chequeo de turno 1 (intake) corriera
  // ANTES del turno 2 (handoff), la respuesta re-dispararía el intake = repetición.
  // El blindaje es el ORDEN: turno 2 gana, anclado en la última regla del bot.
  it("respuesta de keyword FUERTE al intake ('Boda civil') deriva, NO repite el intake (bug Yolany)", () => {
    // La frase coloquial de Yolany dispara el intake (turno 1) igual que cualquier VdA.
    expect(mentionsValleDeAngeles("La de valle de angeles")).toBe(true);
    // La trampa: su respuesta ES, por sí sola, un isEventInquiry (keyword fuerte).
    // Sin la precedencia del turno 2, "Boda civil" volvería a caer en el intake.
    expect(isEventInquiry("Boda civil")).toBe(true);
    // Blindaje: con el intake como última regla del bot, "Boda civil" (o cualquier
    // respuesta) es turno 2 → handoff, aunque el estado se haya perdido por concurrencia.
    expect(isEventInquiryTurn2("event_inquiry", "")).toBe(true);
    expect(isEventInquiryTurn2("awaiting_quote_data", "event_inquiry_intake")).toBe(true);
    // Y el "70 personas" suelto (isEventInquiry=false) también se salva por el ancla,
    // en vez de caer al LLM → out_of_scope (grupo grande, sin ciudad en alcance).
    expect(isEventInquiry("70 personas")).toBe(false);
    expect(isEventInquiryTurn2(undefined, "event_inquiry_intake")).toBe(true);
  });
});

describe("CHAT: Villa B11 (Jasmin) — fechas mezcladas entre turnos + falso 'estadía larga' (10-jul-2026)", () => {
  // Conversación real: "16,17 y 18" (jul) → "7,8y 9 de agosto" → "entrar el viernes
  // y salir el domingo" → "viernes 21, sábado y domingo 23". El bot terminó
  // devolviendo "no disponible del 17 jul al 9 ago" (mezcla de un check-in del
  // turno actual con un check-out sobrante de un turno viejo) y clasificó un fin
  // de semana de 2 noches como estadía LARGA (30+ noches), pausando el bot y
  // dejando a la clienta sin respuesta.
  const TODAY = "2026-07-10"; // viernes (verificado: nextWeekday da 17-jul, como en el chat real)

  it("'7,8y 9 de agosto' (lista sin 'del...al') se toma como 3 NOCHES: check-in 7, check-out 10", () => {
    const r = extractDatePhrases("Y para el 7,8y 9 de agosto", TODAY);
    expect(r.checkIn).toBe("2026-08-07");
    expect(r.checkOut).toBe("2026-08-10");
  });

  it("'entrar el viernes y salir el domingo' resuelve AMBAS fechas del mensaje actual (ya no mezcla un check-out viejo)", () => {
    const r = extractDatePhrases("serían 2 una noches entrar el viernes y salir el domingo", TODAY);
    expect(r.checkIn).toBe("2026-07-17");
    expect(r.checkOut).toBe("2026-07-19"); // 2 noches — NO "9 de agosto" de un turno anterior
  });

  it("'viernes 21, sábado y domingo 23' usa el propio día de semana para elegir el MES correcto", () => {
    // 21 de julio 2026 es MARTES (no viernes); 21 de agosto 2026 SÍ es viernes.
    const r = extractDatePhrases("Y para el viernes 21, sábado y domingo 23?", TODAY);
    expect(r.checkIn).toBe("2026-08-21");
    expect(r.checkOut).toBe("2026-08-23");
    const n = nightsBetween(r.checkIn!, r.checkOut!);
    expect(n).toBe(2); // NO 37 noches → nunca debe disparar long_term_inquiry
    expect(n < LONG_TERM_NIGHTS).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT: SSC + chat "." — un "Si" suelto con objeción/indecisión disparaba pago
// (auditoría de inbox 10-jul-2026, ítems #5 y #6)
//
// #5: "Si andamos buscando casa con Piscina" (Casa Marea cotizada NO tiene) y
// "Si, estoy a la espera de la confirmacion de otras personas" (no decidió nada)
// se trataban como confirmación de reserva → el bot saltaba directo a pedir
// método de pago, presionando al cliente.
// #6: Gina Moncada dijo "Quiero reservar" / "quisiera saber qué debo hacer para
// reservar" y el bot NO lo reconocía como confirmación → la respuesta salía del
// flujo determinístico (LLM libre) y terminó mandando "**Número de cuenta:** [Te
// lo enviaré en privado]" literal al cliente, en vez de los datos bancarios reales.
// ─────────────────────────────────────────────────────────────────────────────
describe("CHAT: 'Si' con objeción/indecisión no debe adelantar el pago (10-jul-2026)", () => {
  it("objeción real (SSC): pide piscina, la casa cotizada no tiene — NO es un 'sí, reservo'", () => {
    expect(isConfirmation("Si andamos buscando casa con Piscina")).toBe(false);
  });
  it("indecisión real (chat '.'): sigue esperando que otros decidan — NO confirma", () => {
    expect(isConfirmation("Si, estoy  a la espera  de la.confirmacion de otras personas.")).toBe(false);
  });
  it("intención EXPLÍCITA de reservar (Gina Moncada) sí confirma, sin necesidad de decir 'sí'", () => {
    expect(isConfirmation("Quiero reservar")).toBe(true);
    expect(isConfirmation("Sii quisiera saber que debo hacer para reservar")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT: Karen López — paquete "Friends Trip" (Las Gemelas + day pass, 10-jul-2026)
//
// El botón del anuncio de Click-to-WhatsApp prellenó "quiero información sobre
// la oferta de Tela, Atlántida de L. 6,700" — sin nombrar el paquete ni la
// propiedad. El bot solo veía "Tela" y cotizaba la tarifa PELADA de Casa
// Brisa/Casa Marea (L.2,500/noche), sin mencionar ni cobrar el day pass del
// Hotel Honduras Shores Plantation que la oferta prometía — el valor de la
// oferta se perdía en el camino.
// ─────────────────────────────────────────────────────────────────────────────
describe("CHAT: Karen López — Friends Trip perdía el day pass de la oferta (10-jul-2026)", () => {
  it("el mensaje real del anuncio se reconoce como Friends Trip aunque no nombre el paquete", () => {
    expect(
      detectPackageInquiry("¡Hola! 👋 Quiero más información sobre la oferta de Tela, Atlántida de L. 6,700"),
    ).toBe("friends_trip");
  });

  it("'4 adultos 2 niños 1bb' (mensaje real de Karen) se desglosa correcto — el bebé no cuenta", () => {
    const p = extractPartySize("Es que quiero saber precios para ir a tela con 4 adultos 2 niños 1bb.");
    expect(p.adults).toBe(4);
    expect(p.children).toBe(2);
    expect(p.babies).toBe(1);
    expect(partyHeadcount(p)).toBe(6); // cabe en UNA casa (cupo 6) — no hace falta Las Gemelas combinadas
  });

  it("el day pass de ese grupo en fin de semana da L.1,700 (antes se perdía por completo)", () => {
    const r = computeDayPassHNL({ adults: 4, children: 2, checkIn: "2024-01-05", checkOut: "2024-01-07" }); // viernes a domingo
    expect(r.isWeekend).toBe(true);
    expect(r.hnl).toBe(1700);
  });

  it("los mensajes de intake/precio fijo existen en ambos idiomas y mencionan el day pass / el monto", () => {
    for (const l of ["es", "en"] as const) {
      expect(T.packageFriendsTripIntake(l).toLowerCase()).toContain("day pass");
      expect(T.packageVillaB11Fixed(l)).toContain("5,400");
    }
  });

  // CHAT: Dime (+504 9759-6115, 11-jul-2026) — MISMA familia (Friends Trip/day pass).
  // El cliente dio el desglose en VARIOS grupos: "2 adultos / 1 niño de 12 / 2 niñas
  // de 15". El bot cobró un day pass de "2 adultos + 1 niño" (L.650): se comió las 2
  // niñas de 15 porque extractPartySize solo tomaba el PRIMER grupo de niños.
  it("desglose en varios grupos: '2 adultos, 1 niño de 12, 2 niñas de 15' → 2 adultos + 3 niños (caso Dime)", () => {
    const p = extractPartySize("2 adultos\n1 niño de 12\n2 niñas de 15");
    expect(p.adults).toBe(2);
    expect(p.children).toBe(3);
    expect(partyHeadcount(p)).toBe(5);
  });

  it("el day pass de ese grupo entre semana da L.950 (antes daba L.650, faltaban las 2 niñas)", () => {
    // 14→16 jul 2026 = martes/miércoles (entre semana): adulto L.250, niño L.150.
    const r = computeDayPassHNL({ adults: 2, children: 3, checkIn: "2026-07-14", checkOut: "2026-07-16" });
    expect(r.isWeekend).toBe(false);
    expect(r.hnl).toBe(950); // 2×250 + 3×150 — NO 650 (2×250 + 1×150)
  });
});

describe("CHAT: Carlos Meza — '¿qué fechas tenés disponibles?' (pregunta inversa, 10-jul-2026)", () => {
  // 🐛 CASO REAL — Carlos Meza (+504 9926-1852), Villa B11. El cliente ya sabía que
  // el 13–17 jul estaba ocupado y pidió que le PROPUSIÉRAMOS fechas ("Y que fecha si
  // tienes disponible para villa B11?" → "Dame fechas que tengas disponibles en Villa
  // B11!"). El bot (a) re-cotizó el 13–17 viejo y repitió "no disponible del 13 al 17"
  // —contestó una pregunta que el cliente no hizo— y (b) cayó al LLM, que respondió
  // "no puedo verificar la disponibilidad de fechas específicas" → callejón sin salida,
  // lead frío. Clase: el bot no tenía handler para la pregunta INVERSA de disponibilidad.
  it("los mensajes EXACTOS de Carlos disparan el handler inverso ('villa B11' no es una fecha)", () => {
    expect(isAvailabilityDatesRequest("Y que fecha si tienes disponible para villa B11?")).toBe(true);
    expect(isAvailabilityDatesRequest("Dame fechas que tengas disponibles en Villa B11!")).toBe(true);
  });

  it("un chequeo CON fecha concreta NO dispara el handler inverso → sigue al cotizador real", () => {
    // El mismo cliente, turno 4, SÍ dio fechas → eso debe cotizarse, no reformularse.
    expect(isAvailabilityDatesRequest("Tienes disponibilidad en la semana del 13 al 17 de julio?")).toBe(false);
  });

  it("la respuesta determinística pide un rango concreto y NUNCA dice 'no puedo verificar'", () => {
    for (const l of ["es", "en"] as const) {
      const msg = T.availabilityDatesAsk(l, PROPERTY_PRICING["villa-b11-palma-real"].name);
      expect(msg).toContain("Villa B11 — Palma Real"); // nombra la propiedad del estado
      expect(msg.toLowerCase()).not.toContain("no puedo");
      expect(msg.toLowerCase()).not.toContain("can't");
      expect(msg.toLowerCase()).not.toContain("no está disponible");
      expect(msg.toLowerCase()).not.toContain("not available");
    }
    // Sin propiedad conocida también responde (genérico, sin nombre).
    expect(T.availabilityDatesAsk("es").length).toBeGreaterThan(30);
    // Marca: es neutral (sirve para Tegucigalpa) → sin palmera.
    expect(T.availabilityDatesAsk("es")).not.toContain("🌴");
  });
});

// 🐛 CASO REAL — D'Karoll (+504 3202-4132), 11-jul-2026. Friends Trip Tela. La
// clienta dio "5 adultos 1 niña y una bebé" y el bot contó BIEN ("6 huéspedes",
// la bebé no cuenta 👶), pero con la fecha mandó la tarjeta de `las-gemelas-tela`
// = las DOS casas. Para 6 que cuentan alcanza UNA sola casa (y la oferta L.6,700 es
// para una casa + day pass). Causa: el LLM fijó property=las-gemelas del contexto
// del Friends Trip → esquivó el auto-asignado por headcount. Blindaje determinístico:
// las gemelas SOLO valen para 7-12; con ≤6 se degrada a una casa (marea→brisa).
describe("CHAT: D'Karoll — Friends Trip Tela: 6 que cuentan caben en UNA casa, no en las gemelas", () => {
  it("'5 adultos 1 niña y una bebé' → 5+1=6 que cuentan (la bebé NO cuenta para cupo)", () => {
    const p = extractPartySize("5 adultos 1 niña y una bebé");
    expect(p.adults).toBe(5);
    expect(p.children).toBe(1);
    expect(partyHeadcount(p)).toBe(6);
  });
  it("con 6 (o menos) que cuentan, las gemelas (2 casas) se degrada a UNA casa", () => {
    expect(gemelasOverSized("las-gemelas-tela", 6)).toBe(true);
    expect(gemelasOverSized("las-gemelas-tela", 1)).toBe(true);
  });
  it("7-12 SÍ son las gemelas (no se toca el producto de grupo)", () => {
    expect(gemelasOverSized("las-gemelas-tela", 7)).toBe(false);
    expect(gemelasOverSized("las-gemelas-tela", 12)).toBe(false);
  });
  it("una casa individual nunca se degrada, y sin headcount tampoco", () => {
    expect(gemelasOverSized("casa-marea", 6)).toBe(false);
    expect(gemelasOverSized("casa-brisa", 4)).toBe(false);
    expect(gemelasOverSized("las-gemelas-tela", null)).toBe(false);
    expect(gemelasOverSized(null, 6)).toBe(false);
  });
});

// 🐛 CASO REAL — D'Karoll PARTE 2 (+504 3202-4132), 11-jul-2026, mismo chat, horas
// después. Ya con fechas (22–24 ago), el bot pidió el desglose y la clienta contestó
// "3 adultos y me menores de 14 16 11 y la bebé de 2 años". El parser solo veía
// "3 adultos" (lista de edades sin conteo + bebé sin dígito = invisibles) → (a) el
// turno no contó como dato nuevo (changedQuoteData solo miraba al LLM) → NO cotizó y
// el LLM prometió "te confirmo el total…" que nunca llegó; (b) al "Ok" siguiente el
// merge PERDÍA adults/children (no se restauraban de previousData) → re-disparó
// package_need_party_breakdown VERBATIM: re-preguntó lo que la clienta ya había
// respondido y el propio bot había reconocido. Tres capas determinísticas: parser de
// lista de edades, mergeFriendsTripParty (conserva el desglose + marca cambio) y
// variante de reintento del pedido (nunca la misma pregunta dos veces seguidas).
describe("CHAT: D'Karoll parte 2 — desglose por edades + 'Ok' repetía la pregunta (11-jul-2026)", () => {
  const DESGLOSE = "3 adultos y me menores de 14 16 11 y la bebé de 2 años";

  it("el mensaje real se desglosa: 4 adultos (el de 16 sube) + 2 niños + 1 bebé = 6 que cuentan", () => {
    const p = extractPartySize(DESGLOSE);
    expect(p.adults).toBe(4);   // 3 adultos + el menor de 16 (16+ paga tarifa adulto)
    expect(p.children).toBe(2); // 14 y 11
    expect(p.babies).toBe(1);   // "la bebé de 2 años" es bebé por etiqueta, gratis
    expect(partyHeadcount(p)).toBe(6); // ≤6 → UNA casa (encaja con gemelasOverSized)
  });

  it("el turno del desglose CUENTA como dato nuevo → el cotizador corre (no más 'te confirmo el total' vacío)", () => {
    const r = mergeFriendsTripParty({ adults: null, children: null }, DESGLOSE);
    expect(r.changed).toBe(true);
    expect(r.guests).toBe(6);
  });

  it("el 'Ok' posterior CONSERVA el desglose → package_need_party_breakdown no puede re-disparar", () => {
    const r = mergeFriendsTripParty({ adults: 4, children: 2 }, "Ok");
    expect(r.adults).not.toBeNull(); // el gate pregunta SOLO si adults == null
    expect(r.children).toBe(2);
    expect(r.changed).toBe(false);
  });

  it("day pass del grupo, 22–24 ago 2026 (sábado→lunes = finde): 4×350 + 2×150 = L.1,700", () => {
    const r = computeDayPassHNL({ adults: 4, children: 2, checkIn: "2026-08-22", checkOut: "2026-08-24" });
    expect(r.isWeekend).toBe(true);
    expect(r.hnl).toBe(1700);
  });

  it("la variante de reintento existe en es/en, trae un EJEMPLO de formato y no es la pregunta original", () => {
    for (const l of ["es", "en"] as const) {
      const retry = T.packageNeedPartyBreakdownRetry(l);
      expect(retry).not.toBe(T.packageNeedPartyBreakdown(l)); // nunca verbatim dos veces
      expect(retry).toContain("2"); // ejemplo concreto ("2 adultos y 3 niños…")
      expect(retry.length).toBeGreaterThan(40);
    }
  });
});

describe("CHAT: +504 9872-6411 — Villa B11 OCUPADO 16–18 jul: PROPONER fechas, no solo 'no disponible' (11-jul-2026)", () => {
  // 🐛 CASO REAL — familia de 5, jueves 16 → sábado 18 jul (2 noches). La villa estaba
  // ocupada y el bot solo dijo "no disponible del 16 al 18 jul 😔 ¿otras fechas o
  // propiedad?" y se quedó esperando → lead frío. César: si buscan 2 noches de finde
  // y no hay, el bot debe PROPONER (1) lo más cercano libre y (2) otros fines de
  // semana libres. Es matemática de calendario → CÓDIGO (findAlternativeDates), no
  // prompt: lee el MISMO set de fechas ocupadas con el que se decide "no disponible".
  const TODAY = "2026-07-11";
  const REQ_IN = "2026-07-16"; // jueves
  const REQ_OUT = "2026-07-18"; // 2 noches

  it("con las fechas pedidas ocupadas, propone ventana cercana + otros findes (mismo día de semana)", () => {
    const blocked = new Set(["2026-07-16", "2026-07-17"]);
    const alt = findAlternativeDates(blocked, REQ_IN, REQ_OUT, TODAY);
    expect(alt.nearest).not.toBeNull();
    expect(alt.nearest!.nights).toBe(2);
    expect(alt.weekends.length).toBeGreaterThanOrEqual(1);
    // los findes propuestos son jueves (mismo día que pidió) y están libres
    const reqDow = new Date(REQ_IN + "T00:00:00Z").getUTCDay();
    for (const w of alt.weekends) {
      expect(new Date(w.checkIn + "T00:00:00Z").getUTCDay()).toBe(reqDow);
    }
  });

  it("el mensaje nombra la propiedad, da fechas concretas y NUNCA se cuelga ('no puedo')", () => {
    const alt = findAlternativeDates(new Set(["2026-07-16", "2026-07-17"]), REQ_IN, REQ_OUT, TODAY);
    for (const l of ["es", "en"] as const) {
      const msg = T.unavailableWithAlternatives(l, "Villa B11 — Palma Real", alt, true);
      expect(msg).toContain("Villa B11 — Palma Real");
      expect(msg).toContain(formatWindowHuman(alt.nearest!, l));
      expect(msg.toLowerCase()).not.toContain("no puedo");
      expect(msg.toLowerCase()).not.toContain("can't");
    }
    // Tegucigalpa (no playa) → sin 🌴
    const teg = findAlternativeDates(new Set(["2026-07-16", "2026-07-17"]), REQ_IN, REQ_OUT, TODAY);
    expect(T.unavailableWithAlternatives("es", "Centro Morazán", teg, false)).not.toContain("🌴");
  });
});

describe("CHAT: Méndez — pregunta de capacidad tragada, el bot re-cotizó", () => {
  // Casa Brisa, ya cotizado: "Hasta cuanto es la capacidad de adultos" → el bot re-mandó
  // la cotización (quote_provided) en vez de responder el cupo. La capacidad es un DATO
  // exacto de la propiedad → se responde por código (capacity_answer), no re-cotizando.
  it("la pregunta por el cupo se detecta (y NO se confunde con el headcount propio)", () => {
    expect(isCapacityQuestion("Hasta cuanto es la capacidad de adultos")).toBe(true);
    expect(isCapacityQuestion("Somos 4 adultos u una bb")).toBe(false);
  });
  it("la capacidad sale del DATO exacto de la propiedad, no del LLM", () => {
    // 4 adultos + 1 bebé (la bebé no cuenta) entran sobrados en las 6 de Casa Brisa.
    expect(PROPERTY_PRICING["casa-brisa"].capacity).toBe(6);
  });
  it("el mensaje de capacidad nombra la propiedad y el cupo exacto", () => {
    const p = PROPERTY_PRICING["casa-brisa"];
    const msg = T.capacityAnswer("es", p.name, p.capacity);
    expect(msg).toContain("Casa Brisa");
    expect(msg).toContain("6");
  });
});

describe("CHAT: DVALL — la oferta citada solo por PRECIO no se niega (cableado del gate de paquetes)", () => {
  // "Buen día 6,700 cuantas personas": detectPackageInquiry NO lo agarra (no dice
  // "oferta"/ciudad/nombre) → el gate de paquetes cae al fallback detectPackageByAdPrice,
  // que lo identifica como friends_trip en vez de dejar que el LLM niegue la oferta del
  // anuncio ("la tarifa de L. 6,700 no corresponde a nuestras propiedades").
  it("el precio pelado del anuncio identifica el paquete (fallback del gate)", () => {
    expect(detectPackageInquiry("Buen día 6,700 cuantas personas")).toBeNull();
    expect(detectPackageByAdPrice("Buen día 6,700 cuantas personas", null)).toBe("friends_trip");
  });
  it("guard anti-eco: con propiedad ya cotizada, el mismo monto NO re-dispara paquete", () => {
    // Centro Morazán 3 noches = 2100×3+400 = 6,700 exactos; "¿el total era 6,700?" es eco.
    expect(detectPackageByAdPrice("¿el total era 6,700?", "centro-morazan")).toBeNull();
  });
});

describe("CHAT: lead de Tela — '¿está cerca del mar?' → croquis + guion (13-jul-2026)", () => {
  // Objeción clásica de Tela: qué tan cerca está la casa del mar. Con una propiedad de Tela
  // en el estado, el bot manda el CROQUIS de Honduras Shores Plantation + el dato exacto (mar
  // a 5-7 min caminando, circuito cerrado con seguridad 24/7) por CÓDIGO (beach_proximity_map),
  // sin LLM. La amenidad "¿tiene playa?" sigue yendo a la KB (2 formas de acceso + costo).
  it("la pregunta de PROXIMIDAD al mar se detecta; '¿tiene playa?' (amenidad) NO", () => {
    expect(isBeachProximityQuestion("¿está cerca del mar?")).toBe(true);
    expect(isBeachProximityQuestion("a cuánto queda la playa caminando?")).toBe(true);
    expect(isBeachProximityQuestion("¿tiene playa?")).toBe(false);
  });
  it("el guion trae el dato exacto de César (5-7 min + Honduras Shores Plantation + 24/7)", () => {
    const es = T.beachProximityTela("es");
    expect(es).toMatch(/5\s*a?\s*7/);
    expect(es).toContain("Honduras Shores Plantation");
    expect(es).toContain("24/7");
    const en = T.beachProximityTela("en");
    expect(en).toContain("Honduras Shores Plantation");
    expect(en).toContain("24/7");
  });
  it("el croquis apunta al JPG público del sitio (URL HTTPS que Meta puede descargar)", () => {
    expect(TELA_CROQUIS_URL).toBe(
      "https://estadiasjacari.com/images/las-gemelas-tela/croquis.jpg",
    );
  });
});
