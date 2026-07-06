/**
 * Apps Script — Parser de emails Airbnb para Estadías Jacarí
 *
 * Corre cada 5 min sobre el Gmail de inversionesjacari@gmail.com (o estadiasjacari@gmail.com).
 * Monitorea dos labels:
 *
 *   1. "Airbnb-Reservation"   → emails de CONFIRMACIÓN de reservas nuevas
 *      (asunto típico: "¡Nueva reservación confirmada! ...")
 *      → POST a /api/inbound/airbnb-reservation con los datos parseados
 *
 *   2. "Airbnb-Message"       → emails de MENSAJES del chat de Airbnb
 *      (asunto típico: "Reservación para ..." con texto del huésped)
 *      → POST a /api/inbound/airbnb-message con el texto del mensaje
 *
 * Cuando un email se procesa con éxito, se mueve al label "*-Processed" o se
 * marca como Star + leído para que no se reprocese.
 *
 * SETUP en Google Apps Script (script.google.com):
 *
 *   1. Crear nuevo proyecto Apps Script (script.google.com → "New project")
 *      Nombre: "Estadias Jacari Airbnb Parser"
 *
 *   2. Habilitar Gmail API:
 *      - Services (lado izquierdo) → +Add → "Gmail API" → Add
 *
 *   3. Pegar TODO este archivo en Code.gs (reemplazar el contenido por default)
 *
 *   4. Editar las 3 constantes al inicio (ENDPOINT, SECRET, ...)
 *
 *   5. Trigger time-based:
 *      - Triggers (icono reloj) → +Add Trigger
 *      - Function to run: processNewEmails
 *      - Event source: Time-driven
 *      - Type: Minutes timer
 *      - Interval: Every 5 minutes
 *      - Save → autorizar permisos de Gmail al script
 *
 *   6. Labels en Gmail:
 *      - El script usa el label "Airbnb-Reservations" (el que César YA tiene, con
 *        los correos de reservas). Los labels "-Processed" y "-Failed" los CREA
 *        el script solo — no hay que crear nada a mano.
 *      - (Opcional, para nuevos emails automáticos) crear un filtro:
 *        From: automated@airbnb.com  Asunto: "Nueva reservación confirmada"
 *          → Aplicar label: Airbnb-Reservations
 *
 *   7. Probar manual:
 *      - Apps Script → seleccionar función "processReservations" (menú de arriba)
 *        → botón ▷ Run → ver el Execution log abajo.
 *      - Debería procesar los correos etiquetados y POSTear al endpoint.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BACKFILL HISTÓRICO (respaldo desde enero 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 *   El mismo processReservations() carga el histórico:
 *
 *   1. En Gmail, buscar las confirmaciones viejas, ej:
 *        from:automated@airbnb.com "Nueva reservación confirmada" after:2026/1/1
 *   2. Seleccionarlas todas → aplicar el label "Airbnb-Reservations".
 *      (César ya tiene 49 etiquetadas al 2026-07-01.)
 *   3. Apps Script → función "processReservations" → ▷ Run. Procesa ~300 por
 *      corrida; si quedan, volver a correr (idempotente: NO duplica).
 *   4. En el Execution log, al final: "processReservations FIN: X OK, Y con problema".
 *   5. Los que fallen quedan en "Airbnb-Reservations-Failed". Abrirlos: casi
 *      siempre es un listing con nombre no mapeado — pasarle a Claude el nombre
 *      EXACTO del email para agregarlo a AIRBNB_LISTING_TO_SLUG.
 *
 *   Fechas: el año se infiere de la FECHA DEL EMAIL (no de hoy), así que un email
 *   de enero fecha en 2026 aunque el backfill se corra en julio. (Ver parseDateLine.)
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — César debe editar estas 3 constantes
// ─────────────────────────────────────────────────────────────────────────────

const ENDPOINT_RESERVATION = 'https://estadiasjacari.pages.dev/api/inbound/airbnb-reservation';
const ENDPOINT_MESSAGE     = 'https://estadiasjacari.pages.dev/api/inbound/airbnb-message';

// IMPORTANTE: pegar el valor real de AIRBNB_INBOUND_SECRET aquí.
// Debe coincidir con el env var de Cloudflare Pages.
// Generar con: openssl rand -hex 32
const AIRBNB_INBOUND_SECRET = 'PEGAR_AQUI_VALOR_GENERADO_CON_OPENSSL';

// Labels que el script revisa.
// PENDING: el label que YA usa César en Gmail (captura 2026-07-01 → "Airbnb-Reservations",
// en plural, con 49 correos). Se resuelve por candidatos para tolerar singular/plural.
// DONE y FAILED se crean solos si no existen (César no crea nada a mano).
const LABEL_RESERVATION_PENDING_CANDIDATES = ['Airbnb-Reservations', 'Airbnb-Reservation'];
const LABEL_RESERVATION_DONE    = 'Airbnb-Reservations-Processed';
const LABEL_RESERVATION_FAILED  = 'Airbnb-Reservations-Failed'; // no parseó o el endpoint lo rechazó → revisión manual
const LABEL_MESSAGE_PENDING_CANDIDATES = ['Airbnb-Messages', 'Airbnb-Message'];
const LABEL_MESSAGE_DONE        = 'Airbnb-Messages-Processed';

/** Devuelve el primer label existente de la lista de candidatos, o null. */
function resolveExistingLabel(candidates) {
  for (const n of candidates) {
    const l = GmailApp.getUserLabelByName(n);
    if (l) return l;
  }
  return null;
}
/** Label por nombre, creándolo si no existe. */
function ensureLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — corre cada 5 min por el trigger time-based
// ─────────────────────────────────────────────────────────────────────────────

function processNewEmails() {
  try {
    processReservations();
  } catch (err) {
    console.error('processReservations error:', err);
  }
  try {
    processMessages();
  } catch (err) {
    console.error('processMessages error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESERVATIONS — emails de "Nueva reservación confirmada"
// ─────────────────────────────────────────────────────────────────────────────

function processReservations() {
  const label = resolveExistingLabel(LABEL_RESERVATION_PENDING_CANDIDATES);
  if (!label) {
    console.warn(`No existe ninguno de estos labels: ${LABEL_RESERVATION_PENDING_CANDIDATES.join(', ')}. Aplicá "Airbnb-Reservations" a los correos de reservas.`);
    return;
  }
  console.log(`Usando label pendiente: "${label.getName()}"`);
  // DONE y FAILED se crean solos (César no crea labels a mano).
  const doneLabel = ensureLabel(LABEL_RESERVATION_DONE);
  const failedLabel = ensureLabel(LABEL_RESERVATION_FAILED);

  // Procesa en lotes hasta agotar el label o llegar al límite de seguridad.
  // El mismo código sirve para el trigger de 5 min (pocos threads nuevos) y para
  // el BACKFILL histórico (cientos de emails ya etiquetados): el endpoint es
  // idempotente (INSERT OR IGNORE por confirmationCode), así que re-correr no
  // duplica. MAX_BATCHES evita pasar el límite de 6 min de ejecución de Apps Script.
  const BATCH = 20;
  const MAX_BATCHES = 15; // ~300 emails por corrida; volver a correr si quedan
  let processed = 0, failed = 0;

  for (let b = 0; b < MAX_BATCHES; b++) {
    // Siempre desde 0: al mover los OK al label Done, la "ventana" avanza sola.
    const threads = label.getThreads(0, BATCH);
    if (threads.length === 0) break;
    console.log(`processReservations lote ${b + 1}: ${threads.length} threads pendientes`);

    for (const thread of threads) {
      const messages = thread.getMessages();
      // Tomar el último mensaje del thread (el más reciente)
      const msg = messages[messages.length - 1];
      const body = msg.getPlainBody();
      const subject = msg.getSubject();
      // Fecha del email como referencia de AÑO (clave para backfill histórico:
      // un email de enero no debe fecharse en el año siguiente).
      const refDate = msg.getDate();

      const parsed = parseReservationEmail(subject, body, refDate);
      if (!parsed) {
        console.warn(`No se pudo parsear thread "${subject}" → ${LABEL_RESERVATION_FAILED}`);
        label.removeFromThread(thread);
        failedLabel.addToThread(thread);
        failed++;
        continue;
      }

      const result = postToEndpoint(ENDPOINT_RESERVATION, parsed);
      if (result.ok) {
        console.log(`Reserva ${parsed.confirmationCode} (${parsed.checkIn}) OK: ${result.response.slice(0, 160)}`);
        label.removeFromThread(thread);
        failedLabel.removeFromThread(thread); // si venía de un reintento, limpiar Failed
        doneLabel.addToThread(thread);
        processed++;
      } else {
        console.error(`Falló reserva ${parsed.confirmationCode} — listing "${parsed.listingName}": ${result.error}`);
        // Mapeo faltante o rechazo del endpoint: mover a Failed para no atascar
        // el backfill. Queda parkeado y visible; re-etiquetar a pending para reintentar.
        label.removeFromThread(thread);
        failedLabel.addToThread(thread);
        failed++;
      }
    }
  }
  console.log(`processReservations FIN: ${processed} OK, ${failed} con problema (revisar logs).`);
}

/**
 * Parsea el cuerpo PLANO del email de confirmación de Airbnb (host).
 * Formato REAL confirmado con un email de 2026 (Estadías Jacarí):
 *
 *   Subject: "Reservación confirmada: <Nombre completo> llega el 29 jun."
 *            (o "¡Nueva reservación confirmada! <Nombre> llega el ...")
 *
 *   Body (los ENCABEZADOS vienen en MAYÚSCULAS y con mucho whitespace):
 *     https://www.airbnb.com.hn/rooms/952839282667005627?c=...   <- ancla
 *     PARAÍSO PLAYERO: TELABEACHOUSE, HONDURAS                    <- listing
 *     Vivienda o apartamento entero                              <- tipo
 *     Check-in      Check-out                                    <- encabezado
 *     lun, 29 jun   mar, 30 jun                                  <- ¡2 fechas EN 1 LÍNEA!
 *     3:00 p.m.     11:00 a.m.
 *     VIAJEROS
 *     4 adultos, 1 niño
 *     CÓDIGO DE CONFIRMACIÓN
 *     HMW98PBAJD
 *     EL HUÉSPED PAGÓ ... TOTAL (USD)   $125.53                  <- lo que pagó el huésped
 *     COBRO AL ANFITRIÓN ... GANAS   $106.70                     <- lo que RECIBE César (=ingreso)
 *
 * Decisión: amountUsd = GANAS (payout al anfitrión), NO el total del huésped,
 * porque el respaldo es de INGRESO real. Si Airbnb cambia el formato, ajustar
 * las anclas de abajo (usá debugDumpRawEmail para ver el cuerpo crudo).
 */
function parseReservationEmail(subject, body, refDate) {
  // refDate = fecha en que Airbnb envió el email (msg.getDate()); referencia de
  // AÑO para fechas del cuerpo (clave para backfill histórico correcto).
  refDate = refDate instanceof Date ? refDate : new Date();
  // Trabajamos con líneas RECORTADAS: el cuerpo trae padding gigante.
  const lines = String(body || '').split('\n').map((l) => l.trim());
  const clean = lines.join('\n');

  // 1) Código de confirmación (Airbnb siempre empieza con "HM")
  const confirmationCode = extractConfirmationCode(lines);
  if (!confirmationCode) {
    console.warn('parseReservationEmail: no se encontró código de confirmación');
    return null;
  }

  // 2) Nombre del huésped — del ASUNTO ("...confirmada[:!] NOMBRE llega..."),
  //    con fallback al encabezado del cuerpo.
  const guestName = extractGuestName(subject) || extractGuestName(clean);
  if (!guestName) {
    console.warn('parseReservationEmail: no se encontró nombre del huésped');
    return null;
  }

  // 3) Listing name — primera línea de texto tras la URL de /rooms/ (o antes del tipo)
  const listingName = extractListingName(lines);
  if (!listingName) {
    console.warn('parseReservationEmail: no se encontró listing name');
    return null;
  }

  // 4) Fechas check-in / check-out
  const dates = parseCheckInOut(lines, refDate);
  if (!dates) {
    console.warn('parseReservationEmail: no se encontraron fechas check-in/out');
    return null;
  }

  // 5) Viajeros (adultos + niños + bebés)
  const guestCount = parseGuestCount(lines) || 1;

  // 6) Monto — GANAS (payout al anfitrión = ingreso real de César). El símbolo
  //    "$" puede ir ANTES ("$106.70", perfil viejo) o DESPUÉS del número
  //    ("77,22 $", perfil nuevo), y el decimal puede ser punto o coma. parseMoney
  //    normaliza ambos. (El regex viejo exigía "$número" con $ delante → fallaba
  //    en el formato nuevo y dejaba el monto en blanco.)
  let amountUsd;
  const ganasMatch = clean.match(/\bGanas\b[\s:]*\$?\s*([\d.,]+)\s*\$?/i);
  if (ganasMatch) amountUsd = parseMoney(ganasMatch[1]);

  // 7) Ubicación del huésped (opcional): línea tras "· N reseñas"
  let guestLocation;
  const locMatch = clean.match(/(?:rese[ñn]as?|reviews?)\s*\n\s*([A-Za-zÀ-ÿ0-9 .,'’\-]+)/i);
  if (locMatch) guestLocation = locMatch[1].trim();

  return {
    listingName,
    confirmationCode,
    guestName,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    guestCount,
    amountUsd,
    guestLocation,
  };
}

// ── Helpers de parseo (formato real Airbnb host) ────────────────────────────

const MONTH_MAP = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};

/** Nombre del huésped desde "...confirmada[:!] NOMBRE llega...". */
function extractGuestName(text) {
  if (!text) return '';
  const m = String(text).match(/confirmad[ao][:!¡\s]+(.+?)\s+llega\b/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/** Código de confirmación: anclado a la etiqueta, o fallback "HM…" en cualquier lado. */
function extractConfirmationCode(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/c[oó]digo de confirmaci[oó]n|confirmation code/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length && j < i + 5; j++) {
        const mm = lines[j].match(/^([A-Z0-9]{6,12})$/);
        if (mm) return mm[1].toUpperCase();
      }
    }
  }
  // Fallback: los códigos de Airbnb empiezan con "HM" (aparece también en URLs).
  const any = lines.join('\n').match(/\bHM[A-Z0-9]{6,10}\b/);
  return any ? any[0].toUpperCase() : '';
}

/** Listing: primera línea de texto real tras la URL /rooms/; fallback antes del tipo. */
function extractListingName(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.indexOf('/rooms/') !== -1 && l.charAt(0) !== '[') {
      for (let j = i + 1; j < lines.length && j < i + 6; j++) {
        const t = lines[j];
        if (!t || t.indexOf('http') === 0 || t.charAt(0) === '[') continue;
        return t;
      }
    }
  }
  // Fallback: línea no vacía justo antes de "Vivienda…/Habitación…".
  for (let i = 0; i < lines.length; i++) {
    if (/^(vivienda|habitaci[oó]n)\b/i.test(lines[i])) {
      for (let j = i - 1; j >= 0 && j > i - 5; j--) {
        const t = lines[j];
        if (t && t.indexOf('http') !== 0 && t.charAt(0) !== '[') return t;
      }
    }
  }
  return '';
}

/**
 * Normaliza un monto de texto a Number, tolerando ambos formatos de Airbnb:
 *   "77,22" (coma decimal, perfil nuevo) · "106.70" (punto decimal, perfil viejo)
 *   "1.234,56" · "1,234.53" (con separador de miles).
 * Regla: el separador decimal es el ÚLTIMO seguido de EXACTAMENTE 2 dígitos; el
 * resto son miles. Sin decimales ("80") → entero.
 *
 * MANTENER IDÉNTICA a functions/_lib/airbnb-parser.ts::parseMoney (Apps Script
 * no corre vitest, así que la lógica se testea ahí — 2026-07-06, regresión del
 * bug ×100 cubierta con 10+ casos). Si tocás esta función, portá el cambio y
 * corré `npm test` en estadia-jacari antes de pegar acá.
 *
 * Solo se llama con `ganasMatch[1]` (línea de abajo) — una captura de regex,
 * siempre string con 2 decimales. NO llamarla con un número ya parseado: un
 * `Number` de JS pierde ceros finales al volverse texto y rompería la regla
 * de "2 dígitos exactos" (ver el comentario espejo en airbnb-parser.ts).
 */
function parseMoney(s) {
  s = String(s).replace(/[^\d.,]/g, '');
  if (!s) return undefined;
  const m = s.match(/[.,](\d{2})$/);
  if (m) {
    const intPart = s.slice(0, s.length - 3).replace(/[.,]/g, '');
    const n = parseFloat((intPart || '0') + '.' + m[1]);
    return isNaN(n) ? undefined : n;
  }
  const n = parseFloat(s.replace(/[.,]/g, ''));
  return isNaN(n) ? undefined : n;
}

/** day (num) + monthStr → YYYY-MM-DD, con año inferido de refDate (email). */
function dayMonthToIso(day, monthStr, refDate) {
  const month = MONTH_MAP[String(monthStr).toLowerCase().slice(0, 3)];
  if (!month || !day) return null;
  let year = refDate.getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (candidate.getTime() < refDate.getTime() - 30 * 86400000) year += 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Regex de fecha RESTRINGIDA a meses reales (ene…dic). Evita que "5 adultos",
// "2 noches" o "3.0 %" se confundan con fechas — era el bug del regex viejo
// `[a-záéíóúñ]{3,}` que aceptaba cualquier palabra tras un número.
const DATE_RE_SRC = '(\\d{1,2})\\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)';

/**
 * Fechas check-in/out. Cubre TRES formatos del email host de Airbnb:
 *   1) Etiquetas ES nuevas ("Llegada"/"Salida") o viejas ("check-in/out"),
 *      cada fecha en su línea ("jue, 25 dic").
 *   2) Columnar: dos fechas en UNA línea ("lun, 29 jun   mar, 30 jun").
 *   3) Fallback total: las primeras dos fechas del cuerpo, en orden (ci < co).
 */
function parseCheckInOut(lines, refDate) {
  const dateReLine = new RegExp(DATE_RE_SRC, 'gi');

  // 1) Por etiqueta (llegada/salida = ES nuevo; check-in/out = viejo/EN).
  const lci = dateAfterLabel(lines, /llegada|check-?in/i, refDate);
  const lco = dateAfterLabel(lines, /salida|check-?out/i, refDate);
  if (lci && lco && lci < lco) return { checkIn: lci, checkOut: lco };

  // 2) Columnar: una línea con >=2 fechas.
  for (let i = 0; i < lines.length; i++) {
    dateReLine.lastIndex = 0;
    const found = [];
    let m;
    while ((m = dateReLine.exec(lines[i])) !== null) found.push(m);
    if (found.length >= 2) {
      const a = dayMonthToIso(parseInt(found[0][1], 10), found[0][2], refDate);
      const b = dayMonthToIso(parseInt(found[1][1], 10), found[1][2], refDate);
      if (a && b && a < b) return { checkIn: a, checkOut: b };
    }
  }

  // 3) Fallback total: recolectar todas las fechas del cuerpo y tomar el primer
  //    par ascendente (check-in antes que check-out).
  const all = [];
  for (const line of lines) {
    dateReLine.lastIndex = 0;
    let m;
    while ((m = dateReLine.exec(line)) !== null) {
      const iso = dayMonthToIso(parseInt(m[1], 10), m[2], refDate);
      if (iso) all.push(iso);
    }
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i] < all[j]) return { checkIn: all[i], checkOut: all[j] };
    }
  }
  return null;
}

function dateAfterLabel(lines, labelRe, refDate) {
  const dateRe = new RegExp(DATE_RE_SRC, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (labelRe.test(lines[i])) {
      for (let j = i + 1; j < lines.length && j < i + 4; j++) {
        const m = lines[j].match(dateRe);
        if (m) { const iso = dayMonthToIso(parseInt(m[1], 10), m[2], refDate); if (iso) return iso; }
      }
    }
  }
  return null;
}

/** Viajeros: suma adultos + niños + bebés de la línea bajo "VIAJEROS". */
function parseGuestCount(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^viajeros$/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length && j < i + 4; j++) {
        const t = lines[j];
        if (!t) continue;
        const ad = t.match(/(\d+)\s+adultos?/i);
        const ni = t.match(/(\d+)\s+ni[ñn][oa]s?/i);
        const be = t.match(/(\d+)\s+beb[eé]s?/i);
        const n = (ad ? +ad[1] : 0) + (ni ? +ni[1] : 0) + (be ? +be[1] : 0);
        if (n > 0) return n;
      }
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES — emails de "Reservación para ..." con mensaje del huésped
// ─────────────────────────────────────────────────────────────────────────────

function processMessages() {
  const label = resolveExistingLabel(LABEL_MESSAGE_PENDING_CANDIDATES);
  if (!label) {
    // Opcional: solo aplica si César etiqueta mensajes de huéspedes. Silencioso.
    console.log(`Sin label de mensajes (${LABEL_MESSAGE_PENDING_CANDIDATES.join('/')}); nada que hacer.`);
    return;
  }
  const doneLabel = ensureLabel(LABEL_MESSAGE_DONE);

  const threads = label.getThreads(0, 20);
  console.log(`processMessages: ${threads.length} threads con label "${label.getName()}"`);

  for (const thread of threads) {
    const messages = thread.getMessages();
    const msg = messages[messages.length - 1];
    const body = msg.getPlainBody();
    const subject = msg.getSubject();

    const parsed = parseMessageEmail(subject, body);
    if (!parsed) {
      console.warn(`No se pudo parsear mensaje "${subject}"`);
      continue;
    }

    const result = postToEndpoint(ENDPOINT_MESSAGE, parsed);
    if (result.ok) {
      console.log(`Mensaje procesado: ${parsed.guestName} — ${result.response.slice(0, 200)}`);
      label.removeFromThread(thread);
      doneLabel.addToThread(thread);
    } else {
      console.error(`Falló mensaje: ${result.error}`);
    }
  }
}

/**
 * Parsea email de "Reservación para X". Extrae:
 *   - guestName (de la línea "Responsable de reservación")
 *   - messageText (el cuerpo del mensaje real, no la firma de Airbnb)
 *   - confirmationCode (si aparece en el subject o body)
 *
 * Subject típico:
 *   "Reservación para Business Stay-5 Star Location-Torre Morazan-Views, para 27 – 28 de may"
 *
 * Body típico:
 *   "Por tu seguridad y protección, comunícate siempre a través de la plataforma de Airbnb.
 *    Ruth
 *    Ruth
 *    Responsable de reservación
 *    Mi familia está cerca. ¿Podrías enviármelo lo antes posible, por favor?"
 */
function parseMessageEmail(subject, body) {
  // Guest name — buscar línea antes de "Responsable de reservación"
  let guestName = '';
  const respIdx = body.indexOf('Responsable de reservación');
  if (respIdx > 0) {
    const before = body.slice(0, respIdx).trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    // El nombre típicamente aparece 1-2 veces antes; tomar el último
    guestName = before[before.length - 1] || '';
  }

  // Message text — todo lo que viene DESPUÉS de "Responsable de reservación"
  // y ANTES de "Traducción automática" o de la firma del footer
  let messageText = '';
  if (respIdx > 0) {
    let after = body.slice(respIdx + 'Responsable de reservación'.length);
    // Cortar en "Traducción automática" si existe
    const tradIdx = after.indexOf('Traducción automática');
    if (tradIdx > 0) after = after.slice(0, tradIdx);
    // Cortar en el typical footer
    const footerMatches = ['Por tu seguridad', 'Inicia sesión', 'Airbnb Ireland', 'Términos de pago'];
    for (const f of footerMatches) {
      const idx = after.indexOf(f);
      if (idx > 0) after = after.slice(0, idx);
    }
    messageText = after.trim();
  }

  if (!messageText) {
    console.warn('parseMessageEmail: no se encontró cuerpo del mensaje');
    return null;
  }

  // Confirmation code (puede o no estar en el body — Airbnb a veces lo omite en chat)
  let confirmationCode;
  const codeMatch = body.match(/(?:Código|Code)\s*[:\s]+([A-Z0-9]{6,12})/i);
  if (codeMatch) confirmationCode = codeMatch[1].toUpperCase();

  return {
    confirmationCode,
    guestName,
    messageText,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

function postToEndpoint(url, payload) {
  if (!AIRBNB_INBOUND_SECRET || AIRBNB_INBOUND_SECRET === 'PEGAR_AQUI_VALOR_GENERADO_CON_OPENSSL') {
    return { ok: false, error: 'AIRBNB_INBOUND_SECRET no configurado en Apps Script' };
  }

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + AIRBNB_INBOUND_SECRET },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code >= 200 && code < 300) {
      return { ok: true, response: body };
    }
    return { ok: false, error: `HTTP ${code}: ${body.slice(0, 500)}` };
  } catch (err) {
    return { ok: false, error: 'Excepción red: ' + err.toString() };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Para debug manual desde el editor Apps Script
// ─────────────────────────────────────────────────────────────────────────────

function debugLatestReservationEmail() {
  const label = resolveExistingLabel(LABEL_RESERVATION_PENDING_CANDIDATES);
  if (!label) { console.log('Label de reservas no existe'); return; }
  const threads = label.getThreads(0, 1);
  if (threads.length === 0) { console.log('Sin emails pending'); return; }
  const msg = threads[0].getMessages()[0];
  const parsed = parseReservationEmail(msg.getSubject(), msg.getPlainBody(), msg.getDate());
  console.log('SUBJECT:', msg.getSubject(), '| EMAIL DATE:', msg.getDate());
  console.log('PARSED:', JSON.stringify(parsed, null, 2));
}

function debugLatestMessageEmail() {
  const label = resolveExistingLabel(LABEL_MESSAGE_PENDING_CANDIDATES);
  if (!label) { console.log('Label de mensajes no existe'); return; }
  const threads = label.getThreads(0, 1);
  if (threads.length === 0) { console.log('Sin emails pending'); return; }
  const msg = threads[0].getMessages()[0];
  const parsed = parseMessageEmail(msg.getSubject(), msg.getPlainBody());
  console.log('SUBJECT:', msg.getSubject());
  console.log('PARSED:', JSON.stringify(parsed, null, 2));
}
