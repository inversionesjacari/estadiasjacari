//
// detectors.ts — Detectores rápidos puros (sin LLM, sin imports tóxicos).
//
// Extraídos de quote-flow.ts para poder testearlos en aislamiento con Vitest
// (quote-flow.ts importa D1/OpenAI/ical y no se puede cargar en un test unitario).
// Son funciones PURAS: string -> boolean/number. Su comportamiento está
// blindado por functions/_lib/__tests__/detectors.test.ts — si tocás una regex,
// el test te avisa si rompés un caso real ya visto.
//

/**
 * Reglas "terminales": el bot ya cerró / derivó / cobró esta conversación. Ni el
 * followup de "armemos cotización" ni el último aviso ni el watchdog de "bot mudo"
 * deben insistirle a alguien que se despidió, pagó y confirmó, o fue escalado.
 * (Caso Sandra, 12-jun: pagó y su reserva quedó confirmada, y el followup le dijo
 * "contame personas y fechas" → la hizo dudar de su propia reserva.) Única fuente
 * de verdad — antes vivía duplicada solo en quote-followups.ts.
 */
export const TERMINAL_RULES = new Set([
  "out_of_scope_redirect", "existing_guest_escalation", "payment_reported",
  "transfer_proof_received", "transfer_confirmed_deposit", "transfer_confirmed_full",
  "escalar_humano", "call_requested", "farewell", "event_inquiry_handoff",
  // Pregunta en el paso de comprobante que ningún detector supo responder → escaló a
  // César; el followup NO debe nagear "¿pudiste transferir?" mientras la pregunta
  // sigue en manos del humano (caso +504 9583-9796, 13-jul-2026).
  "transfer_question_escalated",
]);

/** Detecta si un texto tiene intención de pedir cotización / precio. */
export function isPriceIntent(text: string): boolean {
  const norm = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡]/g, "")
    .trim();
  const patterns = [
    "precio",
    "cuanto cuesta",
    "cuanto sale",
    "cuanto vale",
    "tarifa",
    "cotizacion",
    "cotizar",
    "cuanto es",
    "valor",
    "que tal sale",
    "que precios",
    "tienen disponibilidad",
    "hay disponibilidad",
    "esta disponible",
    "estan disponibles",
    "reservar",
    "quiero reservar",
    "me interesa rentar",
    "me interesa alquilar",
  ];
  return patterns.some((p) => norm.includes(p));
}

/** Detecta intent de confirmación afirmativa. */
/**
 * ¿El mensaje es una consulta de DISPONIBILIDAD o un CAMBIO DE FECHA (no un "sí")?
 * Ej: "Pero si estaría disponible para el 17 de junio?", "y si lo cambio al 20",
 * "mejor el viernes", "del 20 al 22". Sirve para (1) que NO se confunda con una
 * confirmación (acá "si" es "if", no "sí") y (2) re-cotizar cuando el cliente cambia
 * de fechas en pleno flujo — el bot DEBE adaptarse, no machacar el pago.
 */
export function isDateChangeOrAvailabilityQuestion(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return (
    /\b(disponible|disponibilidad)\b/.test(t) ||
    /\b(otra fecha|otras fechas|otro dia|cambiar|cambio|lo paso|lo pasamos|mejor el|mejor para|mejor las?|y si (lo|mejor|el|para)|que tal (el|si|para)|se puede (el|para|mover|cambiar))\b/.test(t) ||
    /\bsi (estaria|seria|sera|esta|estuviera|fuera|hay|tienen|tendrian|hubiera|tuvieran|pudiera|se puede|es posible|hubiese)\b/.test(t) ||
    /\bdel\s+\d{1,2}\s+(al|a)\s+\d{1,2}\b/.test(t) ||
    /\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/.test(t)
  );
}

/**
 * ¿El cliente nos pide a NOSOTROS que le digamos qué fechas hay libres? (la pregunta
 * INVERSA de disponibilidad). Ej: "¿qué fechas tenés disponibles?", "dame las fechas
 * que tengas libres para Villa B11", "¿cuándo está disponible?", "what dates do you
 * have available?". A diferencia de un chequeo con fechas concretas ("¿está libre del
 * 13 al 17?"), acá el cliente NO propone un rango — quiere que el equipo se lo proponga.
 *
 * Bug real (Carlos Meza, 10-jul-2026, Villa B11): ante "dame fechas que tengas
 * disponibles" el bot (a) repitió el "no disponible del 13 al 17" viejo —re-cotizó un
 * rango que el cliente ya sabía ocupado— y (b) cayó al LLM, que respondió "no puedo
 * verificar la disponibilidad de fechas específicas" → callejón sin salida, lead frío.
 * El bot NO puede enumerar el calendario de forma confiable (el iCal de Airbnb
 * sincroniza cada 2-24 h); su respuesta HONESTA es pedir un rango concreto para
 * chequearlo al instante — nunca repetir un "no disponible" viejo ni decir "no puedo".
 *
 * Guard: si el mensaje ya trae una fecha CONCRETA (día+mes, "del 13 al 17", "el 20"),
 * NO es la pregunta inversa: es un chequeo puntual y debe ir al cotizador real.
 */
export function isAvailabilityDatesRequest(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡]/g, "")
    .trim();

  // Trae una fecha concreta → es un chequeo puntual, no "decime qué hay libre".
  // (\b\d evita falsos positivos con "villa b11": no hay boundary dentro de "b11".)
  const hasConcreteDate =
    /\b\d{1,2}\s*(al|a|-|hasta)\s*\d{1,2}\b/.test(t) ||
    /\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/.test(t) ||
    /\b(el|del|para|desde|llego|llegamos|entro|entramos)\s+\d{1,2}\b/.test(t);
  if (hasConcreteDate) return false;

  // Pide que ENUMEREMOS fechas/días ("qué fechas", "dame los días…", "what dates…").
  const asksWhichDates =
    /\b(que|cual|cuales|cuanta|cuantas|cuantos|q|what|which)\s+(fechas?|dias?|dates?|days?)\b/.test(t) ||
    /\b(dame|deme|decime|dec[ií]|pasame|pasa\s?me|mandame|env[ií]a\s?me|mostrame|muestrame|indicame|dime|digame|give|send|tell)\b[^]*\b(fechas?|dias?|dates?|days?)\b/.test(t);
  // Señal de disponibilidad (para no confundir "¿qué día es el check-in?").
  const availabilityCue =
    /\b(disponible|disponibles|disponibilidad|libre|libres|tenes|tienes|tienen|tengas|tenga|hay|queda|quedan|abiert|available|availability|free|open|have)\b/.test(t);

  return (
    (asksWhichDates && availabilityCue) ||
    /\b(fechas?|dias?)\s+(disponibles?|libres?)\b/.test(t) ||
    /\b(available|free|open)\s+(dates?|days?)\b/.test(t) ||
    /\b(dates?|days?)\s+(available|free|open)\b/.test(t) ||
    /\b(cuando|when)\b[^]*\b(disponible|libre|disponibilidad|available|free|open)\b/.test(t)
  );
}

/**
 * ¿El cliente pregunta por el CUPO de la propiedad? ("¿hasta cuántas personas caben?",
 * "¿cuál es la capacidad?", "cupo máximo?", "how many guests fit?"). Es una PREGUNTA por
 * el máximo — NO el cliente diciendo cuántos son ("somos 4 adultos" es su headcount
 * propio → NO dispara, salvo que además pregunte explícito por caber/capacidad).
 *
 * Bug real (Méndez, 11-jul-2026, Casa Brisa): ya cotizado, el cliente preguntó "Hasta
 * cuánto es la capacidad de adultos" y el bot RE-MANDÓ la cotización entera
 * (`quote_provided`) en vez de responder el cupo → la pregunta quedó sin contestar. La
 * capacidad es un DATO EXACTO (`PROPERTY_PRICING.capacity`), así que el bot debe
 * responderla por CÓDIGO, sin LLM y sin re-cotizar (método: capacidad → determinístico).
 */
export function isCapacityQuestion(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡]/g, "")
    .trim();

  // El cliente DICE cuántos son (headcount propio) ≠ PREGUNTA por el cupo.
  const statesOwnHeadcount =
    /\b(somos|seremos|seriamos|vamos a ser|iriamos|iremos|van a ser|voy con|llevo|llevamos)\b/.test(t);

  const capacityWord = /\b(capacidad|cupo|capacity|occupancy)\b/.test(t);
  const fitVerb =
    /\b(caben?|entran?|admite|acepta|aloja|alojan|duermen?|sleeps?|fit|fits|hold|holds|accommodates?)\b/.test(t);
  const howMany = /\b(cuant[oa]s?|maximo|max|maximum|how many)\b/.test(t);
  const peopleWord =
    /\b(personas?|gente|huespedes?|adultos?|ninos?|pax|people|persons?|guests?|adults?)\b/.test(t);

  // "somos 4 adultos" (headcount) NO es pregunta de cupo — salvo que además diga
  // caben/capacidad ("somos 5, ¿caben?").
  if (statesOwnHeadcount && !capacityWord && !fitVerb) return false;

  return capacityWord || (fitVerb && (howMany || peopleWord)) || (howMany && peopleWord);
}

/**
 * ¿El cliente pregunta qué tan CERCA está la propiedad del mar / la playa?
 * ("¿está cerca del mar?", "¿a cuánto queda la playa?", "¿se puede ir caminando?",
 * "how far is the beach?", "¿es frente al mar?"). Es una pregunta de PROXIMIDAD /
 * DISTANCIA — NO la de amenidad "¿tiene playa?" (esa la responde la KB con las dos
 * formas de acceso a la playa + su costo). Para las propiedades de Tela (Honduras
 * Shores Plantation) la mejor respuesta es el CROQUIS del complejo (con la propiedad
 * circulada en rojo) + el dato exacto (mar a 5-7 min caminando, circuito cerrado con
 * seguridad 24/7), así que se responde por CÓDIGO mandando la imagen, sin LLM (pedido
 * de César, 13-jul-2026 → intercepción beach_proximity_map en quote-flow).
 *
 * Requiere un sustantivo de mar/playa Y una señal de proximidad/distancia (o un claim
 * de "frente al mar / a pasos / beachfront", que ya ES proximidad). Sin ambas no dispara:
 * "¿tiene playa?" (solo amenidad) → false; "¿está cerca del centro?" (sin mar) → false.
 * "\bmar\b" NO matchea "Casa Marea" (no hay boundary dentro de "marea").
 */
export function isBeachProximityQuestion(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿¡]/g, "")
    .trim();

  const beachNoun =
    /\b(playas?|mar|oceano|costa|orilla|beach|sea|ocean|shore|seaside|coast)\b/.test(t);

  // "frente al mar / a pasos del mar / beachfront / oceanfront" ya ES una pregunta de
  // proximidad, aunque no traiga "cerca"/"lejos" → self-contained (menciona el mar).
  const frontage =
    /\bfrente\s+(al|a\s+la)\s+(mar|playa)\b/.test(t) ||
    /\ba\s+pasos\s+del?\s+(mar|playa)\b/.test(t) ||
    /\b(beach|ocean|sea|water)\s?front\b/.test(t);
  if (frontage) return true;

  const proximityCue =
    /\b(cerca|cerquita|cercan[oa]s?|cercania|lejos|lejan[oa]s?|distancia|caminando|caminar|camina|pegad[oa]s?|minutos?|mins?|minute|cuadras?|metros?|kilometros?|km)\b/.test(t) ||
    /\b(a\s+cuant[oa]s?|que\s+tan\s+(cerca|lejos)|a\s+pie)\b/.test(t) ||
    /\bhow\s+(far|close|near)\b/.test(t) ||
    /\bwalking\s+distance\b/.test(t) ||
    /\bwalk\s+to\b/.test(t) ||
    /\bsteps\s+(from|to)\b/.test(t) ||
    /\b(near|nearby)\b/.test(t) ||
    /\bclose\s+to\b/.test(t);

  return beachNoun && proximityCue;
}

/**
 * Confirmación CLARA de la cotización. Conservador: una NEGACIÓN, una PREGUNTA, o un
 * CAMBIO DE FECHA/disponibilidad lo descartan. Acá "si" suele ser "if", no "sí" — bug
 * real (caso Zedileth): "Pero si estaría disponible para el 17 de junio?" hizo que el
 * bot pidiera pagar en vez de re-cotizar. El cliente debe poder cambiar de idea sin
 * que lo mandemos a cobrar.
 */
export function isConfirmation(text: string): boolean {
  const norm = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  // Negación clara → NO es confirmación, aunque incluya "ya"/"ok"/"listo".
  if (/\b(no|nel|nop|tampoco|nada|ya no|olvidalo|dejalo|cancela|cancelar|mejor no)\b/.test(norm)) {
    return false;
  }
  // Pregunta o cambio de fecha/disponibilidad → re-cotizar, NO confirmar ni cobrar.
  if (/\?/.test(norm) || isDateChangeOrAvailabilityQuestion(text)) {
    return false;
  }
  // Despedida / cierre cortés → NO es confirmación (era "Ok buen día" → el bot le
  // pedía pagar a alguien que se despedía). PERO si además hay un "sí" FUERTE
  // (sí/dale/confirmo/perfecto/claro/de acuerdo), la despedida es solo cortesía y SÍ
  // confirma ("perfecto, buen día"). "ok"/"ya"/"listo" son débiles: con despedida
  // pesan como cierre, no como "cobrá".
  const farewell = /\b(buen dia|buenos dias|adios|hasta luego|hasta pronto|nos vemos|cuidate|que (tengas|tenga|te vaya)|feliz dia|buen finde)\b/.test(norm);
  const strongYes = /\b(si|claro|por supuesto|confirmo|dale|de acuerdo|perfecto)\b/.test(norm);
  if (farewell && !strongYes) {
    return false;
  }
  // "Si" + una cláusula que en realidad sigue indecisa/pendiente → NO es confirmación
  // (casos reales 10-jul-2026: "Si andamos buscando casa CON PISCINA" —objeción, la
  // casa cotizada no tiene—; "Si, estoy a la espera de la confirmacion de otras
  // personas" —todavía no decide—). El "si" acá es muletilla conversacional ("sí,
  // así es que..."), no un asentimiento a la reserva. Mismo espíritu que el guard de
  // despedida: un "si" suelto pesa poco si el resto de la frase dice lo contrario.
  const stillDeciding = /\b(andamos\s+buscando|estamos\s+buscando|seguimos\s+buscando|a\s+la\s+espera\s+de|esperando\s+(la\s+|una\s+)?confirmacion|esperando\s+que|todavia\s+(estamos|no)|aun\s+(estamos|no))\b/.test(norm);
  if (stillDeciding) {
    return false;
  }
  // Intención EXPLÍCITA de reservar ("quiero reservar", "qué debo hacer para
  // reservar") también confirma, aunque no diga "sí" — caso real Gina Moncada,
  // 10-jul-2026: sin esto, el bot no reconocía "Quiero reservar"/"quisiera saber
  // qué debo hacer para reservar" como confirmación, la LLM improvisaba la
  // respuesta por fuera del flujo determinístico y terminó mandando el placeholder
  // "[Te lo enviaré en privado]" en vez de los datos bancarios reales.
  if (/\b(quiero|quisiera|deseo|necesito)\b[^.!]*\breservar\b|\bpara reservar\b|\bhacer la reserva\b/.test(norm)) {
    return true;
  }
  // Objeción / lamento con un "si" incidental (conjunción "if", no "sí" — el acento se
  // normaliza, así que no se distinguen). El cliente expresa una TRABA ("lástima que…",
  // "es mucho alquilar dos casas", "nos gusta pero el límite…"), no un asentimiento a la
  // reserva. Caso real 13-jul-2026 (+504 9583-9796): "Nos gusta más la villa… sentimos
  // que SI nos ubicamos bien pero lastima que ud tiene ese límite… es mucho alquilar dos
  // casa realmente 🥺" → el bot lo tomó como "sí" y saltó a cobrar (y de ahí se trabó en
  // el clarify de pago). Un "sí" FUERTE (dale/confirmo/de acuerdo/perfecto/claro/por
  // supuesto) desactiva el guard; un "si"/"ya"/"ok" pelado no pesa contra una objeción
  // explícita. Misma familia que Zedileth (si=if), variante OBJECIÓN (sin "?" ni fecha).
  const strongYesForObjection = /\b(dale|confirmo|de acuerdo|perfecto|claro|por supuesto)\b/.test(norm);
  const objection =
    /\blastima\b/.test(norm) ||
    /\bpero\b[^.!?]{0,40}\b(limite|caro|mucho|lejos|pequen\w*|problema|dificil|complicad\w*|no\s+(tiene|hay|cabe|entran?))\b/.test(norm) ||
    /\bes\s+(mucho|demasiado)\b[^.!?]{0,25}\b(alquilar|dos\s+casas?|caro|dinero|para\s+nosotros|el\s+espacio)\b/.test(norm);
  if (objection && !strongYesForObjection) {
    return false;
  }
  return /\b(si|claro|por supuesto|ok|dale|confirmo|de acuerdo|perfecto|ya|listo)\b/.test(norm);
}

/** Detecta si el huésped eligió tarjeta/PayPal. */
export function isCardChoice(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(tarjeta|paypal|tdc|tdb|credito|cr[eé]dito|d[eé]bito|link)\b/.test(t);
}

/** Detecta si el huésped eligió transferencia bancaria. */
export function isTransferChoice(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(transferencia|transferir|banco|cuenta|dep[oó]sito|deposito|bac|ach)\b/.test(t);
}

/** Detecta si el huésped pide los DATOS de cuenta para transferir. */
export function isBankAccountRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(transferencia|transferir|dep[oó]sito|deposito)\b/.test(t) ||
    /(a qu[eé] cuenta|n[uú]mero de cuenta|datos de la? cuenta|datos bancarios|cuenta del banco|cuenta bac|d[oó]nde (transfiero|deposito|dep[oó]sito|pago))/.test(t)
  );
}

/** Detecta si el huésped pide ver fotos / conocer la propiedad (es/en). Incluye
 *  pedir las REDES SOCIALES / Instagram / la página "para ver el lugar": eso es un
 *  pedido de fotos, NO algo fuera de alcance (era la causa del escalado de Natalia). */
export function isPhotoRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (
    /\b(foto|fotos|fotografia|fotografias|imagen|imagenes)\b/.test(t) ||
    /(ver|conocer|mostrar|muestra|ensena).{0,15}(casa|propiedad|lugar|villa|apartamento|depto|cuarto|habitaci)/.test(t) ||
    // pide las redes / el perfil / la página "para ver el lugar" → es pedir fotos
    /\b(redes sociales|red social|instagram|insta|facebook|tiktok|su perfil|su pagina|pagina web|sitio web|catalogo)\b/.test(t) ||
    /\b(photo|photos|picture|pictures|images?|social media|instagram|facebook)\b/.test(t) ||
    /(see|show).{0,15}(house|place|property|villa|apartment|room)/.test(t)
  );
}

/**
 * ¿Pide fotos específicamente de las HABITACIONES / dormitorios (no la sala/cocina)?
 * Cubre el typo común "abitaciones". (Caso real 14-jun: pidió "fotos de las
 * habitaciones" y el bot le mandó la sala/tarjeta.)
 */
export function isBedroomPhotoRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return /\b(habitacion|habitaciones|abitacion|abitaciones|dormitorio|dormitorios|recamara|recamaras|las camas|los cuartos|el cuarto|bedroom|bedrooms)\b/.test(t);
}

/**
 * Señales CLARAS de que el lead ya NO está interesado: rechazó por precio, se
 * despidió, o postergó. Se usa para NO molestarlo con el "último aviso" antes de
 * cerrar la ventana de 24h. Conservador: solo casos evidentes (mejor dejar pasar
 * un cierre sutil que insistirle a alguien que ya dijo que no).
 */
export function isNotInterested(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return (
    // rechazo por precio
    /\b(no me conviene|muy caro|esta caro|carisimo|fuera de (mi )?presupuesto|no me alcanza|esta fuera de)\b/.test(t) ||
    /\bse (me )?(pasa|va|sale)\b.{0,8}presupuesto\b/.test(t) ||
    // no tiene el dinero (distinto de "no me alcanza" — acá el cliente dice que
    // directamente no cuenta con la plata, no que el precio se pasa de su presupuesto).
    // Caso real: "gracias pero no tengo dinero" contado como RESPUESTA positiva en el
    // reporte de followups de la pista B3 — era un rechazo, no una recuperación.
    /\b(no tengo|no cuento con|no traigo|ando corto de)\b.{0,10}\b(dinero|plata|efectivo|presupuesto|esa cantidad|ese dinero)\b/.test(t) ||
    // rechazo directo / no quiere reservar (era el bucle: "no me interesa", "no le e pedido").
    // Cubre pasado/presente/futuro y el typo "e" por "he": pedido/pedi/pido/pedir/solicité…
    /\b(no me interesa|ya no me interesa|no me sirve|no quiero (reservar|nada)|no voy a reservar|no (le )?(he |e |voy a |quiero )?(ped\w*|pid[eo]|solicit\w*)|no he (solicitado|reservado))\b/.test(t) ||
    // postergación / "otra vez será"
    /\b(lo pienso|lo voy a pensar|despues (te )?(veo|aviso|escribo|digo)|mas adelante|otra ocasion|por ahora no|no por ahora|sera (en )?otra|en otra ocasion|tal vez (luego|despues|mas adelante))\b/.test(t) ||
    // despedida cortés como mensaje completo (no "gracias, ¿cómo pago?")
    /^(muchas gracias|gracias|ok gracias|listo gracias|igualmente|esta bien gracias)[.! ]*$/.test(t)
  );
}

/** Detecta si el huésped reporta que ya hizo el pago (escalar para verificar). */
export function isPaymentReported(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return /\b(ya pague|ya page|ya transferi|hice el deposito|ya deposite|pago realizado|pago hecho|ya hice el pago|envie el comprobante|aqui esta el comprobante|adjunto comprobante)\b/.test(t);
}

/**
 * En el paso "esperando comprobante", el cliente dice que TODAVÍA no hizo la
 * transferencia o la posterga (no es un comprobante). Ej: "No", "todavía no",
 * "primero se valida con la familia", "después", "mañana".
 */
export function indicatesNotDoneYet(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return (
    /^(no|nop|todavia no|aun no|negativo)\b/.test(t) ||
    /\b(todavia no|aun no|primero|despues|mas tarde|luego|manana|en un rato|ahorita no|no (lo|la) (he|hice)|no he (hecho|transferido|pagado)|estamos validando|se valida|valido con|consulto con|consultar con|aun estamos|todavia estamos)\b/.test(t)
  );
}

/** Cliente pide explícitamente que lo llamen por teléfono → mejor lo toma un humano
 *  (César llama). No tiene sentido seguir el flujo automático si quiere hablar. */
export function isCallRequested(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return /\b(me puede llamar|me pueden llamar|puede llamarme|pueden llamarme|que me llame|que me llamen|llamenme|llamame|me puede marcar|me pueden marcar|marquenme|prefiero una llamada|mejor una llamada|quiero una llamada|me podrian llamar|podrian llamarme)\b/.test(t);
}

/**
 * Cliente pide un NÚMERO de teléfono / contacto para llamar él (distinto de pedir
 * que LO llamen, que es isCallRequested). Pedir un teléfono NO es "fuera de
 * alcance": se da el número, amablemente y directo.
 */
export function isPhoneNumberRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // "numero" solo cuenta con contexto telefónico/contacto/llamar — así NO roba
  // "numero de personas" ni "numero de cuenta" (eso es isBankAccountRequest).
  return (
    /\b(numero de telefono|numero telefonico|numero de contacto|telefono de contacto|numero para llamar)\b/.test(t) ||
    /\b(tienen|tenes|tienes|hay) (un |algun )?telefono\b/.test(t) ||
    /\b(me (pasas?|pasan?|das?|dan?|facilitas?)|me (podes|podrias) (pasar|dar)) (un |el |su |tu )?telefono\b/.test(t) ||
    /\b(a que (numero|telefono)) (llamo|los llamo|marco|marcar|puedo llamar|te llamo)\b/.test(t) ||
    /\b(ocupo|necesito|quiero|dame|deme|pasame|paseme) (un |el |su |tu )?telefono\b/.test(t) ||
    /\b(phone number|number to call|contact number|your (phone )?number)\b/.test(t)
  );
}

/**
 * Cliente con DUDA de legitimidad / miedo a estafa: "¿son reales?", "¿esto es
 * estafa?", "¿es confiable?", "¿cómo confirmo su veracidad?", "¿es seguro pagar?".
 * Es la objeción más cara JUSTO antes de transferir: el cliente tiene la plata
 * lista y solo le falta confianza. Ignorarla —o, peor, repetir "mandame el
 * comprobante"— lo hace huir y nos hace ver como la estafa que teme. Se atiende
 * determinístico en CUALQUIER estado, con pruebas reales (empresa registrada +
 * redes + Airbnb). NO roba "número de cuenta" (eso es isBankAccountRequest).
 */
export function isLegitimacyQuestion(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (
    // estafa / fraude / engaño / timo
    /\b(estafa|estafan|estafar|fraude|fraudulent|timo|enga[nñ]o|enga[nñ]an)\b/.test(t) ||
    // ¿son reales? / ¿esto es real? / ¿de verdad existen?
    /\b(son|es|sera|seran) reales?\b/.test(t) ||
    /\b(esto|esta|este|todo|ustedes) (es|son) (real|reales|cierto|verdad)\b/.test(t) ||
    /\b(de verdad|realmente) (existen|son reales?|trabajan|alquilan|rentan)\b/.test(t) ||
    // confiable / de fiar / serios / legítimos
    /\b(confiable|confiables|de fiar|son serios|es serio|legitim[oa]s?|reales)\b/.test(t) ||
    /\b(puedo|se puede|podemos) confiar\b/.test(t) ||
    // veracidad / verificar / "cómo sé que son reales / no es estafa"
    /\bveracidad\b/.test(t) ||
    /\bconfirmar (su|la) (veracidad|legitimidad|autenticidad|identidad)\b/.test(t) ||
    /\bcomo\b.*\b(se que|confirmo|verifico|compruebo|asegur)\b.*\b(real|reales|estafa|confiable|legitim|cierto|fiar|veracidad)\b/.test(t) ||
    // ¿es seguro pagar / transferir?
    /\bes seguro\b.*\b(pagar|transferir|deposit|comprar|reservar|enviar|mandar)\b/.test(t) ||
    // inglés
    /\b(is|are) (this|you|it|they)( a)? (real|legit|legitimate|trustworthy|scam|safe)\b/.test(t) ||
    /\b(scam|fraud|legit|trustworthy)\b/.test(t) ||
    /\bhow (do|can) i (know|be sure|trust|verify)\b/.test(t) ||
    /\bis it safe to (pay|transfer|send)\b/.test(t) ||
    /\bcan i trust\b/.test(t)
  );
}

/**
 * Despedida / cierre CLARO del cliente como mensaje completo ("ya no gracias",
 * "no gracias", "gracias", "está bien gracias", "adiós", "thanks"). Cierra la
 * conversación con UNA despedida cálida (no es lo mismo que "gracias, ¿cómo pago?"
 * — eso lleva más texto y no matchea por el ancla ^…$).
 */
export function isFarewell(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return (
    /^((muchas |mil )?gracias|ya no gracias|no,? gracias|ok,? gracias|okay gracias|listo,? gracias|esta bien,? gracias|gracias igualmente|igualmente|adios|nos vemos|hasta luego|hasta pronto|bye|goodbye|thank you|thanks|ty)[.,!\s🙏👍🙂😊]*$/.test(t) ||
    // Un "no" simple, o "no" + una razón corta + "gracias", o "no" + despedida —
    // cierres reales que el ancla de arriba no cubre por tener texto extra en
    // medio ("No, pues son nuestros días libres, gracias"; "No, hasta luego"; "No"
    // suelto). Caso real 6-jul-2026: sin esto, el bot repitió "no disponible" 7
    // VECES SEGUIDAS porque ninguna de esas respuestas se reconocía como cierre.
    /^no[.,!\s]*$/.test(t) ||
    /^no[,\s].{0,60}\bgracias\b[.,!\s]*$/.test(t) ||
    /^no[,\s]+(hasta luego|adios|nos vemos|hasta pronto)\b/.test(t)
  );
}

/**
 * Acuse mínimo / "ok" suelto como mensaje completo ("ok", "vale", "dale",
 * "listo", "perfecto", "entendido", "👍"). Solo se SILENCIA si viene DESPUÉS de
 * una despedida (si no, puede significar "ok = sí" y sigue al flujo normal).
 */
export function isBareAck(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  return /^(si|sii+|sip|simon|ok|okay|okey|oki|oka|vale|dale|listo|perfecto|excelente|entendido|de acuerdo|esta bien|bien|va|sale|ok va|got it|sounds good|alright|👍|👌|🙏|👏|🙂|😊)[.,!\s🙏👍👌🙂😊]*$/.test(t);
}

/**
 * Cliente con intención de reservar que POSTERGA la confirmación ("le confirmaría la
 * otra semana", "lo confirmo después", "te aviso", "déjame pensarlo"). Distinto de un
 * rechazo (isNotInterested) o una despedida: sigue interesado, solo lo deja para
 * luego. Se le responde con el recordatorio de que las fechas se apartan SOLO con el
 * depósito (motiva sin presionar). Exige verbo de postergación + tiempo, o una frase
 * de postergación clara — así NO confunde "quiero reservar la otra semana" (eso lleva
 * "reservar", no es postergar) con "te confirmo la otra semana".
 */
export function isPostponing(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const deferVerb = /(confirm|avis|decid|piens|pensar|consult|te escribo|te digo|le digo|lo veo|lo reviso)/;
  const deferTime = /(la otra semana|la proxima semana|la semana que viene|el proximo mes|mas adelante|en unos dias|otro dia|otro momento|despues|luego|manana|mas tarde|el lunes|el martes|el miercoles|el jueves|el viernes|el sabado|el domingo|el finde|fin de semana)/;
  return (
    /\b(mas adelante|en unos dias|otro dia|otro momento|lo pienso|lo voy a pensar|dejame pensarlo|lo tengo que pensar|lo consulto y)\b/.test(t) ||
    (deferVerb.test(t) && deferTime.test(t)) ||
    /\b(next week|in a few days|later this week|let me think|i'?ll (confirm|let you know)|i will confirm|i'?ll get back)\b/.test(t)
  );
}

/** A partir de cuántas noches una estadía se considera LARGO PLAZO (un mes o más) →
 *  no se cotiza por noche; lo evalúa el equipo con una propuesta a medida. Ajustable. */
export const LONG_TERM_NIGHTS = 30;

/** Noches entre dos fechas YYYY-MM-DD (check-out exclusivo). */
export function nightsBetween(checkInIso: string, checkOutIso: string): number {
  const start = new Date(checkInIso + "T00:00:00Z").getTime();
  const end = new Date(checkOutIso + "T00:00:00Z").getTime();
  if (isNaN(start) || isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
}

/**
 * Cliente pide explícitamente una renta a LARGO PLAZO ("largo plazo", "varios meses",
 * "alquiler mensual", "por medio año"…). Es un caso especial: armamos una propuesta a
 * medida (descuento mensual, condiciones) en vez de la tarifa por noche → lo evalúa
 * César. La duración larga por FECHAS se detecta aparte (nightsBetween ≥ LONG_TERM_NIGHTS).
 */
export function isLongTermRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return /\b(largo plazo|a largo plazo|por (varios|unos) meses|varios meses|unos meses|algunos meses|alquiler mensual|renta mensual|por mes(es)?|mensualidad|por (medio|un) ano|todo el ano|temporada larga|estadia larga|long[- ]?term|monthly rental|several months|a few months|for (a|some) months)\b/.test(t);
}

/**
 * Ciudad NUESTRA nombrada en el texto ("Ceiba", "desde Tegucigalpa", "tela") —
 * backup determinístico de la extracción del LLM. Nació del caso Alisson (7-jul):
 * el LLM clasificó "Ceiba" suelto como out_of_scope dos veces seguidas; un mensaje
 * que nombra una ciudad en la que SÍ operamos jamás debe poder terminar ahí.
 * Devuelve el nombre EXACTO que usa el resto del sistema (tipo City) o undefined.
 */
export function cityFromText(text: string): "La Ceiba" | "Tela" | "Tegucigalpa" | undefined {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/\btela\b/.test(t)) return "Tela";
  if (/\b(la\s*)?ceiba\b/.test(t)) return "La Ceiba";
  if (/\b(tegucigalpa|tegus|tgu)\b/.test(t)) return "Tegucigalpa";
  return undefined;
}

/**
 * Valle de Ángeles nombrado en el texto. Es el venue de EVENTOS (bodas, cumpleaños,
 * corporativos — ads "Jacarí eventos", jul-2026): ahí NO se cotizan noches, así que
 * mencionarlo SIEMPRE manda al flujo de eventos, nunca al cotizador de estadías.
 */
export function mentionsValleDeAngeles(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return /\bvalle de (los )?angeles\b/.test(t);
}

/**
 * ¿El mensaje es una consulta de EVENTO (boda, bautizo, corporativo…) y no de
 * estadía? El bot NO cotiza eventos: junta tipo + fecha + personas y deriva al
 * equipo. Diseño en capas para no robarle leads al cotizador de noches:
 *   1. Valle de Ángeles nombrado → SIEMPRE evento (el venue es solo de eventos).
 *   2. Ciudad/propiedad NUESTRA nombrada → NUNCA evento ("queremos Casa Brisa
 *      para el cumpleaños de mi mamá" es una estadía que se cotiza normal).
 *   3. Tipo de evento FUERTE (boda, bautizo, quinceañera, corporativo…) → evento.
 *   4. Palabras DÉBILES ("evento", "cumpleaños", "celebrar"…) solo con contexto
 *      de VENUE ("salón", "espacio", "local", "alquilan"…) — un "es para un
 *      cumpleaños" suelto en medio de una cotización no debe desviar el flujo.
 */
export function isEventInquiry(text: string): boolean {
  if (mentionsValleDeAngeles(text)) return true;
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Señal de alojamiento nuestro → es una estadía, no un evento.
  if (cityFromText(text) !== undefined) return false;
  if (/\b(casa\s*(brisa|marea|lara)|villa\s*b\s*-?\s*11|palma real|morazan|la florida|gemelas)\b/.test(t)) return false;
  // Tipos de evento fuertes → evento aunque no nombre el venue.
  if (/\b(bodas?|bautizos?|quincean\w*|xv anos|quince anos|baby shower|despedida de solter[oa]|eventos? corporativos?|weddings?|corporate events?)\b/.test(t)) {
    return true;
  }
  // Débiles: requieren además contexto de venue/alquiler de espacio.
  const weak  = /\b(eventos?|cumplean\w*|cumple|brunch|celebracion(es)?|celebrar|graduacion(es)?|aniversario)\b/.test(t);
  const venue = /\b(salon(es)?|espacio|local|lugar|alquil\w*|rent\w*|jardin|venue)\b/.test(t);
  return weak && venue;
}

export type PackageType = "family_pack" | "love_trip" | "friends_trip";

/**
 * ¿El mensaje se refiere a uno de los paquetes armados con marketing (9-jul-2026):
 * "Family pack"/"Love Trip" (Villa B11, La Ceiba, precio FIJO L.5,400 sin importar
 * cuántos son) o "Friends Trip" (Las Gemelas, Tela, + day pass del Hotel Honduras
 * Shores Plantation — precio VARÍA por adultos/niños y día de semana). Caso real
 * (Karen López, 10-jul-2026): el botón del anuncio de Click-to-WhatsApp prellena
 * "quiero información sobre la oferta de Tela, Atlántida de L. 6,700" — sin nombrar
 * el paquete ni la propiedad — así que además del nombre reconocemos ese patrón
 * genérico "oferta de <ciudad>". Sin esto, el bot cotizaba la tarifa pelada de la
 * casa y perdía el day pass que la oferta prometía (el capture failure real).
 */
export function detectPackageInquiry(text: string): PackageType | null {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/\bfriends?\s*trip\b/.test(t)) return "friends_trip";
  if (/\bfamily\s*pack\b/.test(t)) return "family_pack";
  if (/\blove\s*trip\b/.test(t)) return "love_trip";
  // Patrón genérico del anuncio real: "oferta de <ciudad>" sin nombrar el paquete.
  if (/\boferta\b/.test(t)) {
    if (/\btela\b/.test(t)) return "friends_trip";
    if (/\b(la\s+)?ceiba\b|\bpalma\s*real\b/.test(t)) return "family_pack";
  }
  return null;
}

/**
 * Variante del anuncio citada solo por PRECIO: el cliente pregunta por el monto
 * pelado, sin decir "oferta", la ciudad ni el nombre del paquete. Caso real
 * (DVALL, 11-jul-2026): "Buen día 6,700 cuantas personas" — nada de eso pasa
 * `detectPackageInquiry`, el turno caía al LLM y este NEGABA la oferta ("la
 * tarifa de L. 6,700 no corresponde a nuestras propiedades", su prompt solo
 * conoce la tarifa por noche) — un lead del anuncio muerto en el segundo
 * mensaje. Los precios publicados funcionan como identificador del paquete:
 * L.6,300 / L.6,700 (ejemplos del anuncio Friends Trip, Tela) y L.5,400
 * (Family pack / Love Trip, Villa B11 — `VILLA_B11_PACKAGE_TOTAL_HNL`).
 *
 * `previousProperty` es el guard anti-eco: un total YA cotizado puede valer
 * exactamente un monto del anuncio (Centro Morazán 3 noches = 2100×3+400 =
 * L.6,700) y el cliente puede repetirlo ("¿el total era 6,700?"). Como toda
 * cotización previa implica una propiedad fijada en el estado, si ya hay
 * propiedad el número se trata como eco de la cotización (null); en una
 * conversación sin propiedad no hay nada cotizado que repetir — el monto solo
 * puede venir del anuncio.
 */
export function detectPackageByAdPrice(
  text: string,
  previousProperty: string | null,
): PackageType | null {
  if (previousProperty != null) return null;
  if (/\b6[.,]?700\b|\b6[.,]?300\b/.test(text)) return "friends_trip";
  if (/\b5[.,]?400\b/.test(text)) return "family_pack";
  return null;
}

/**
 * ¿El REPLY del LLM afirma disponibilidad o un precio TOTAL de estadía? Esas dos
 * cosas SOLO pueden salir del cotizador real (buildQuote + chequeo de Airbnb/D1),
 * nunca del texto libre del modelo. Caso real (16-jun-2026, Casa Lara): el LLM dijo
 * "¡Perfecto! Te confirmo que está disponible... el precio total es de L.3,580" DOS
 * turnos después de que el chequeo real ya había dicho NO disponible — el followup
 * expuso la contradicción 20h después y el lead se perdió. Se testea sobre el reply
 * del BOT (no del cliente). La tarifa POR NOCHE de la KB es legítima y NO matchea
 * (el modelo la tiene en su prompt); lo prohibido es el TOTAL calculado y el
 * veredicto de disponibilidad — en ambos sentidos: afirmar "sí está" sin verificar
 * pierde plata por sobreventa, afirmar "no está" sin verificar pierde la venta.
 */
export function isUnverifiedQuoteClaim(reply: string): boolean {
  const t = reply.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (
    // veredicto de disponibilidad (afirmativo o negativo), no una oferta de revisar
    /\b(esta|estan|sigue|siguen) disponibles?\b/.test(t) ||
    /\bte confirmo que\b/.test(t) ||
    /\btenemos disponibilidad\b/.test(t) ||
    /\bno (esta|estan|hay) disponib/.test(t) ||
    // precio TOTAL de la estadía (el por-noche de la KB es legítimo)
    /\bprecio total\b/.test(t) ||
    /\btotal (es|seria|serian|de la estadia|a pagar|te quedaria)\b/.test(t) ||
    /\bproceder con (la|tu) reserva\b/.test(t) ||
    // inglés
    /\bis (still )?available\b/.test(t) ||
    /\b(isn'?t|not) available\b/.test(t) ||
    /\btotal (price|cost|would be|comes to)\b/.test(t) ||
    /\bto proceed with (the|your) (booking|reservation)\b/.test(t)
  );
}

/**
 * ¿Hay una señal DETERMINÍSTICA de que la clasificación `intent = "out_of_scope"`
 * del LLM está mal — el pedido SÍ es nuestro? Exige una CIUDAD o PROPIEDAD nuestra
 * nombrada (en el texto, en lo que extrajo el LLM, o ya fijada de un turno previo).
 * A PROPÓSITO no alcanza con un número de huéspedes grande solo: un pedido
 * genuinamente fuera de alcance ("Roatán para 8 personas") también trae un número
 * grande y NO debe forzarse a in-scope por eso — terminaría preguntando "¿qué
 * propiedad?" para una zona que no tenemos. (Ese hueco vivió en producción unas
 * horas tras el fix inicial del caso Alisson, 7-jul-2026 — corregido acá.)
 */
export function hasInScopeSignal(
  text: string,
  extractedCity: string | null,
  extractedProperty: string | null,
  previousCity: string | null,
  previousProperty: string | null,
): boolean {
  const cityNamed = cityFromText(text) ?? extractedCity ?? previousCity ?? null;
  return cityNamed != null || extractedProperty != null || previousProperty != null;
}

/** Cliente pide la ubicación / cómo llegar / el mapa. */
export function isLocationRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return /\b(ubicacion|ubicados?|ubicada|donde (estan|esta|queda|quedan|se encuentra|ubicad)|como llegar|direccion|el mapa|un mapa|en maps|google maps|location|where (are|is)|address)\b/.test(t);
}

/**
 * Cliente pregunta por el HORARIO de check-in / check-out ("a qué hora puedo
 * entrar/llegar", "hora de entrada/salida", "horario", "entradas y salidas",
 * "check-in time"). El dato es FIJO y conocido (3 PM / 11 AM, todas las
 * propiedades), pero los pasos determinísticos de pago se TRAGABAN la pregunta
 * (caso Sandra, 12-jun: la repitió 3 veces eligiendo método y esperando el
 * comprobante, y el bot repitió el guion de pago ignorándola). NO roba "a qué
 * CUENTA" (isBankAccountRequest) ni "cuántas personas".
 */
export function isCheckinTimeRequest(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (
    /\b(check[ -]?in|check[ -]?out|checkin|checkout)\b/.test(t) ||
    /\bhorarios?\b/.test(t) ||
    /\b(entradas? y salidas?|entrada y salida)\b/.test(t) ||
    /\bhora (de |del )?(entrada|salida|ingreso|llegada|check)/.test(t) ||
    // "a/qué hora puedo entrar/llegar/ingresar/salir" (incluye "aque hora" pegado)
    /\b(a ?que|que|cual|a cual|cuanto|desde que|hasta que) hora\b.*\b(entr|lleg|ingres|sal[ieg]|registr|check)/.test(t) ||
    /\b(entr|lleg|ingres|sal[ieg]|registr)\w*\b.*\ba ?que hora\b/.test(t) ||
    /\b(what time|check[ -]?in time|check[ -]?out time|arrival time)\b/.test(t) ||
    /\bwhat time (can|do|should) i (check ?in|arrive|get in|come in|leave|check ?out)\b/.test(t)
  );
}

/**
 * Pregunta/confirmación del TOTAL a pagar ("¿ese es el total por las 2 noches?",
 * "¿cuánto sería el total?", "¿ya incluye la limpieza?"). Plata = dato exacto → se
 * responde por CÓDIGO con la misma fuente que cotizó (buildQuote), nunca con el
 * guion de pago. Caso real 13-jul-2026 (+504 9583-9796, awaiting_transfer_proof):
 * la pregunta del total escondía una CONFUSIÓN DE PROPIEDAD — el monto enviado era
 * el depósito 50% de las gemelas (10,700/2 = 5,350) y el cliente creía que era el
 * total de una casa sola (2×2,500+350 = 5,350, el MISMO número) — y el bot repitió
 * "mandame el comprobante" dos veces. El recap que esto habilita (propiedad + total
 * vs monto a transferir) destapa esa confusión en el momento.
 * Guards: headcount ("en total somos 6") y reporte de pago ("ya pagué el total")
 * NO son la pregunta.
 */
export function isTotalConfirmationQuestion(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // "total" de PERSONAS ("en total somos 6", "somos 8 en total", "el total de adultos")
  // → headcount, no plata. Estrecho a propósito: una pregunta de plata que menciona al
  // grupo ("¿cuánto es el total por las 6 personas?") SÍ debe pasar, y un reporte de
  // pago que ADEMÁS pregunta ("ya transferí, ¿ese es el total?") también — la pregunta
  // gana (2 hallazgos de la revisión adversaria: el guard ancho mataba ambas). Un
  // reporte SIN forma de pregunta ("ya pagué el total") no matchea ningún positivo.
  if (
    /\b(somos|seremos|son|vamos|viajamos)\s+\d+\s+en\s+total\b/.test(t) ||
    /\ben\s+total\s+(somos|seremos|vamos|viajamos)\b/.test(t) ||
    /\btotal\s+de\s+(personas|adultos|ninos|ninas|huespedes|bebes)\b/.test(t)
  ) {
    return false;
  }
  return (
    // "¿cuánto es/sería el total (a pagar)?" / "¿cuál es el precio final?"
    /\b(cuanto|cual)\b[^.!?]{0,30}\b(total|precio final|monto final)\b/.test(t) ||
    // "¿y el total cuánto sería?" (orden invertido)
    /\btotal\b[^.!?]{0,25}\bcuanto\b/.test(t) ||
    // "¿cuánto le debo / tengo que pagar / me sale / sería por todo?"
    /\bcuanto\b[^.!?]{0,20}\b(debo|debemos|tengo\s+que\s+pagar|hay\s+que\s+pagar|me\s+sale|nos\s+sale|sale|por\s+todo)\b/.test(t) ||
    // "¿cuánto falta/resta/queda por pagar?"
    /\bcuanto\b[^.!?]{0,20}\b(falta|resta|queda)\b[^.!?]{0,15}\b(pagar|abonar|cancelar)\b/.test(t) ||
    // "¿ese/eso es/era el total…?" / "el depósito es el total?" / "es todo lo que pago?"
    /\b(es|era|seria|sera)\s+(el\s+)?(total|precio final|monto final)\b/.test(t) ||
    /\b(es|era|sera|seria)\s+todo\s+lo\s+que\s+(pago|pagamos|debo|pagaria|pagariamos)\b/.test(t) ||
    // "…el total …verdad/cierto/correcto?" / "¿me confirmás el total?"
    /\btotal\b[^.!?]{0,35}\b(verdad|cierto|correcto)\b/.test(t) ||
    /\b(confirmas?|confirme|confirmame|confirma)\b[^.!?]{0,15}\b(el\s+)?total\b/.test(t) ||
    // monto citado: "¿el total es 5,350?" / "¿son 5,350 en total?" / "¿queda cancelado el total?"
    /\btotal\s+(es|son|seria|serian)\s+(de\s+)?[\d.,]+/.test(t) ||
    /\b(es|son|serian?)\s+[\d.,]+\s+en\s+total\b/.test(t) ||
    /\bcancelad[oa]s?\b[^.!?]{0,15}\b(el\s+)?total\b/.test(t) ||
    // "¿(el total) ya incluye la limpieza / impuestos?" / "todo incluido" / "¿incluye todo?"
    // ("incluye todo <cosa>" con objeto es AMENIDAD, no plata — hallazgo adversario:
    //  "¿incluye todo el equipo de cocina?" no debe disparar el recap del total).
    /\b(incluye|incluido|incluida)\b[^.!?]{0,25}\b(limpieza|impuestos?|tasas?|cargos?|total)\b/.test(t) ||
    /\btotal\b[^.!?]{0,15}\bincluye\b/.test(t) ||
    /\btodo\s+incluido\b/.test(t) ||
    /\bincluye\s+todo\s*[?!.,¿¡\s]*$/.test(t) ||
    // English
    /\bis\s+(that|this|it)\s+the\s+total\b/.test(t) ||
    /\bthat('|’)?s\s+the\s+total\b/.test(t) ||
    /\bthe\s+total\s*\?/.test(t) ||
    /\b(what('|’)?s|what\s+is|how\s+much\s+is)\s+the\s+total\b/.test(t) ||
    /\btotal\s+for\s+(the|both|all|our)\b/.test(t) ||
    /\b(all|everything)\s+included\b/.test(t) ||
    /\bdoes\s+(it|that|the\s+price)\s+include\b/.test(t)
  );
}

export interface StayDayPair {
  inDay: number;
  outDay: number;
  /** Mes EXPLÍCITO si el cliente lo dijo ("del 17 de julio al 19") — 1-12, o null.
   *  Quien confirme contra el estado DEBE cotejarlo cuando venga (hallazgo adversario:
   *  "¿del 17 al 19 de octubre?" con reserva en julio no puede dar "¡Confirmado!"). */
  inMonth: number | null;
  outMonth: number | null;
}

const STAY_MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};
const STAY_MONTH_ALT = Object.keys(STAY_MONTHS).join("|");

/**
 * Día de ENTRADA y SALIDA mencionados sin mes ("del 17 al 19", "sería entrar el 17
 * y salida el 19", "entre el 20 y el 22", "desde el 17 hasta el 19"). Complemento
 * determinístico de date-parser.extractDatePhrases (que exige el mes). En los pasos
 * de pago sirve para CONFIRMAR las fechas contra el estado sin LLM — el bot
 * respondía "mandame el comprobante" a una confirmación de fechas (caso
 * +504 9583-9796, 13-jul-2026). NO fija fechas nuevas; solo lee el par de días.
 * Guards (afinados por revisión adversaria): la HORA se chequea POR NÚMERO, no por
 * span — "entrada a las 3 y salida a las 11" (horarios de check-in/out) es null,
 * pero "llegamos el 17 como a las 3 pm y salimos el 19" sí da {17,19}; headcount
 * ("de 17 a 19 personas"), porcentajes y números fuera de 1-31 devuelven null.
 */
export function extractStayDayPair(text: string): StayDayPair | null {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  let inDayS: string, outDayS: string;
  let inMonth: number | null = null;
  let outMonth: number | null = null;

  // Patrón 1 — "del 17 (de julio)? al 19 (de octubre)?" / "desde el 17 hasta el 19":
  // el mes se CAPTURA (no se descarta) para que el que confirma pueda cotejarlo.
  let m = t.match(new RegExp(
    `\\b(?:del|desde\\s+el)\\s+(\\d{1,2})(?:\\s+de\\s+(${STAY_MONTH_ALT}))?\\s+(?:al|hasta\\s+el|a)\\s+(?:el\\s+)?(\\d{1,2})(?:\\s+de\\s+(${STAY_MONTH_ALT}))?\\b`,
  ));
  if (m) {
    inDayS = m[1];
    outDayS = m[3];
    inMonth = m[2] ? STAY_MONTHS[m[2]] ?? null : null;
    outMonth = m[4] ? STAY_MONTHS[m[4]] ?? null : null;
  } else {
    m =
      t.match(/\bentre\s+el\s+(\d{1,2})\s+y\s+(?:el\s+)?(\d{1,2})\b/) ??
      t.match(
        /\b(?:entra(?:r|mos|riamos)?|entrada|llega(?:r|mos|riamos)?|ingres\w+|check[ -]?in)\b[^.!?]{0,25}?\b(?:el\s+)?(\d{1,2})\b[^.!?]{0,30}?\b(?:salida|salir|saliendo|salimos|saldriamos|nos\s+vamos|regres\w+|check[ -]?out)\b[^.!?]{0,25}?\b(?:el\s+)?(\d{1,2})\b/,
      ) ??
      t.match(/\bfrom\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:to|until|till)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (!m || m.index == null) return null;
    inDayS = m[1];
    outDayS = m[2];
    // Estas formas no capturan mes: si el span trae uno explícito, es territorio de
    // date-parser/cotización → null (que lo maneje el flujo normal, no la confirmación).
    if (new RegExp(`\\b(${STAY_MONTH_ALT})\\b`).test(t.slice(m.index, m.index + m[0].length + 15))) {
      return null;
    }
  }
  if (m.index == null) return null;

  // Headcount/edades pegado al par ("de 17 a 19 personas") → no es estadía.
  const span = t.slice(m.index, m.index + m[0].length + 12);
  if (/\b(personas?|adultos?|ninos?|ninas?|huespedes|anos)\b/.test(span)) return null;

  // Guard de HORA por número: "las" antes ("a las 3"), o am/pm/hrs/"de la tarde"/
  // "por ciento" después. Por número y no por span, para no anular pares válidos
  // que además traen hora ("llegamos el 17 como a las 3 pm y salimos el 19").
  const p1 = m.index + m[0].indexOf(inDayS);
  const p2 = m.index + m[0].lastIndexOf(outDayS);
  for (const [p, s] of [[p1, inDayS], [p2, outDayS]] as const) {
    if (/\blas\s*$/.test(t.slice(Math.max(0, p - 8), p))) return null;
    const after = t.slice(p + s.length, p + s.length + 14);
    if (/^\s*(?::\d{2})?\s*(am|pm|hrs?|horas?)\b/.test(after)) return null;
    if (/^\s*de\s+la\s+(tarde|manana|noche)\b/.test(after)) return null;
    if (/^\s*(?:por\s+ciento|%)/.test(after)) return null;
  }

  const inDay = Number(inDayS);
  const outDay = Number(outDayS);
  if (inDay < 1 || inDay > 31 || outDay < 1 || outDay > 31 || inDay === outDay) return null;
  return { inDay, outDay, inMonth, outMonth };
}
