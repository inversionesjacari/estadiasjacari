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
  "escalar_humano", "call_requested", "farewell",
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
  return /^((muchas |mil )?gracias|ya no gracias|no,? gracias|ok,? gracias|okay gracias|listo,? gracias|esta bien,? gracias|gracias igualmente|igualmente|adios|nos vemos|hasta luego|hasta pronto|bye|goodbye|thank you|thanks|ty)[.,!\s🙏👍🙂😊]*$/.test(t);
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
