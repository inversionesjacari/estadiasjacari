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
 * Parsea el cuerpo plano del email de confirmación de Airbnb.
 * Estructura típica del email (a 2026-05):
 *
 *   Subject: ¡Nueva reservación confirmada! Wander Jeremias llega el 29 may.
 *
 *   Body contains:
 *     Wander Jeremias Canelo Espinal
 *     ...
 *     Modern & Comfortable 1 BedRoom Apt
 *     Vivienda o apartamento entero
 *     Check-in
 *     vie, 29 may
 *     2:00 p.m.
 *     Check-out
 *     lun, 1 jun
 *     11:00 a.m.
 *     Viajeros
 *     2 adultos
 *     Código de confirmación
 *     HMXQAHMJ4P
 *     ...
 *     $89.01
 *
 * Si Airbnb cambia el formato del email, hay que ajustar los regex.
 */
function parseReservationEmail(subject, body, refDate) {
  // refDate = fecha en que Airbnb envió el email (msg.getDate()). Se usa como
  // referencia de año para las fechas del cuerpo. Si no se pasa, cae a hoy
  // (comportamiento viejo, correcto para tiempo real pero MAL para backfill).
  refDate = refDate instanceof Date ? refDate : new Date();
  // Confirmation code (HM + 6-10 caracteres alfanuméricos)
  const codeMatch = body.match(/(?:Código de confirmación|Confirmation code)\s*[:\n\r]+\s*([A-Z0-9]{6,12})/i);
  if (!codeMatch) {
    console.warn('parseReservationEmail: no se encontró código de confirmación');
    return null;
  }

  // Guest name — la línea que aparece justo antes de "Identidad verificada" o de los detalles
  // Estrategia: buscar el nombre del subject (ej. "Wander Jeremias") + extender hasta encontrar
  // la línea completa en el body.
  let guestName = '';
  const subjectNameMatch = subject.match(/!\s*([A-Za-záéíóúñÑÁÉÍÓÚ' ]+?)\s+llega/i);
  if (subjectNameMatch) {
    const firstNames = subjectNameMatch[1].trim();
    // Buscar línea completa en el body que empiece con esos primeros nombres
    const bodyLine = body.split('\n').find((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith(firstNames) && trimmed.length > firstNames.length;
    });
    guestName = (bodyLine || firstNames).trim();
  } else {
    // Fallback: buscar línea antes de "Identidad verificada"
    const idIdx = body.indexOf('Identidad verificada');
    if (idIdx > 0) {
      const before = body.slice(0, idIdx).trim().split('\n');
      guestName = (before[before.length - 1] || '').trim();
    }
  }
  if (!guestName) {
    console.warn('parseReservationEmail: no se encontró nombre del huésped');
    return null;
  }

  // Listing name — línea después del nombre, antes de "Vivienda" o "Apartment" o "Casa"
  let listingName = '';
  const typeMatch = body.match(/\n([^\n]+)\n(?:Vivienda|Apartment|Casa|Entire)/);
  if (typeMatch) {
    listingName = typeMatch[1].trim();
  }
  if (!listingName) {
    console.warn('parseReservationEmail: no se encontró listing name');
    return null;
  }

  // Check-in date (año referido a la fecha del email, no a hoy)
  const checkIn = parseDateLine(body, 'Check-in', refDate);
  if (!checkIn) {
    console.warn('parseReservationEmail: no se encontró check-in');
    return null;
  }

  // Check-out date
  const checkOut = parseDateLine(body, 'Check-out', refDate);
  if (!checkOut) {
    console.warn('parseReservationEmail: no se encontró check-out');
    return null;
  }

  // Guest count (ej. "2 adultos", "4 adultos · 1 niño")
  let guestCount = 1;
  const guestsMatch = body.match(/Viajeros\s*[\n\r]+\s*(\d+)\s+adultos?(?:[^\n]*?(\d+)\s+(?:niño|niños))?/i);
  if (guestsMatch) {
    guestCount = parseInt(guestsMatch[1], 10) + (guestsMatch[2] ? parseInt(guestsMatch[2], 10) : 0);
  }

  // Amount USD — primer "$XX.XX" después de "Total (USD)"
  let amountUsd;
  const totalMatch = body.match(/Total\s*\(USD\)\s*[\n\r]+\s*\$([\d,]+\.?\d*)/i);
  if (totalMatch) {
    amountUsd = parseFloat(totalMatch[1].replace(/,/g, ''));
  }

  // Guest location — formato típico: "Ciudad, País" debajo del nombre + reseñas
  let guestLocation;
  const locMatch = body.match(/(?:reseñas?|reviews?)\s*[\n\r]+\s*([A-Za-záéíóúñÑÁÉÍÓÚ ,]+)\s*[\n\r]/i);
  if (locMatch) {
    guestLocation = locMatch[1].trim();
  }

  return {
    listingName,
    confirmationCode: codeMatch[1].toUpperCase(),
    guestName,
    checkIn,
    checkOut,
    guestCount,
    amountUsd,
    guestLocation,
  };
}

/**
 * Parsea fechas estilo "vie, 29 may" o "lun, 1 jun" del cuerpo del email
 * y devuelve YYYY-MM-DD. El email de confirmación se envía POCO ANTES de la
 * estadía, así que el año se infiere respecto a `refDate` (fecha del email):
 * si la fecha cae >30 días ANTES del email, es que cruzó al año siguiente
 * (ej. email de dic para estadía de ene). Usar refDate en vez de hoy es lo que
 * hace correcto el BACKFILL: un email de enero 2026 fecha en 2026, no en 2027.
 */
function parseDateLine(body, label, refDate) {
  const re = new RegExp(`${label}\\s*[\\n\\r]+\\s*(?:[a-zñé]+,\\s*)?(\\d{1,2})\\s+([a-zé]{3,9})`, 'i');
  const m = body.match(re);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthStr = m[2].toLowerCase().slice(0, 3);
  const monthMap = {
    'ene': 1, 'feb': 2, 'mar': 3, 'abr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'ago': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dic': 12,
  };
  const month = monthMap[monthStr];
  if (!month) return null;

  const ref = refDate instanceof Date ? refDate : new Date();
  let year = ref.getFullYear();
  const candidate = new Date(year, month - 1, day);
  // Si la fecha cae >30 días antes del email, la estadía es del año siguiente.
  if (candidate.getTime() < ref.getTime() - 30 * 86400000) {
    year += 1;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
  console.log(`processMessages: ${threads.length} threads con label "${LABEL_MESSAGE_PENDING}"`);

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
