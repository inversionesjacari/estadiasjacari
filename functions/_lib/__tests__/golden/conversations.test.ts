import { describe, it, expect } from "vitest";
import { resolveDates, extractNights } from "../../date-parser";
import {
  isConfirmation,
  isNotInterested,
  isCheckinTimeRequest,
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
} from "../../detectors";
import { normalizePhone } from "../../phone";
import { T } from "../../i18n";
import { PROPERTY_PRICING } from "../../quote-builder";
import { getBedroomPhotos } from "../../property-photos";
import { locationFromText } from "../../quote-flow";
import { fechaEnPalabras } from "../../conversational-bot";

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
