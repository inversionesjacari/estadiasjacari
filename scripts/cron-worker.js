/**
 * Cloudflare Worker — dispara los crons del sitio Estadías Jacarí.
 *
 * Llama por HTTP a los endpoints `/api/cron/*` del sitio (Pages Functions). Se
 * separa en un Worker porque Cloudflare Pages NO soporta Cron Triggers. El Worker
 * no necesita base de datos: la lógica vive en los endpoints; este solo los
 * "patea" con el secreto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ UN SOLO CRON TRIGGER: `* * * * *` (cada minuto).
 *
 * El plan gratis de Cloudflare permite máximo 5 Cron Triggers por Worker. En vez
 * de un trigger por tarea (que choca con ese límite), usamos UN trigger cada
 * minuto y `dueEndpoints()` decide qué disparar según la hora UTC. Así podemos
 * tener tantas tareas como queramos con un solo trigger.
 *
 * Horarios (UTC; Honduras = UTC-6):
 *   cada 2 min   → bot-retry          (auto-recuperación del bot tras glitch del LLM)
 *   cada 10 min  → quote-followups    (seguimiento de cotizaciones a medias)
 *   cada 30 min  → watchdog           (2026-07-06: avisa por WhatsApp si un cron
 *                  se queda callado o falla seguido — ver functions/api/cron/watchdog.ts)
 *   cada hora    → paypal-income      (ingreso Airbnb vía PayPal)
 *   00:00 UTC    → checkin-reminders  (6 PM HN — Correo #2 + WA T-1 día)
 *   00:30/12:00 UTC → conversation-autotag (6:30 PM / 6 AM HN — 2×/día; etiqueta el
 *                  DESENLACE de los chats sin pisar tags manuales; ver B10 doc 11)
 *   11:30 UTC    → bot-qa-run         (5:30 AM HN — QA diario del bot)
 *   13:00/15:00/17:30 UTC → whatsapp-operations (avisos operativos — DESACTIVADO
 *                  hasta cargar property_contacts; descomentar abajo cuando esté)
 *
 * SETUP (una sola vez):
 *   1. Workers & Pages → estadia-jacari-cron → Edit code → pegar TODO → Deploy.
 *   2. Settings → Variables: CRON_SECRET = (el mismo de Pages, encrypted).
 *   3. Settings → Triggers → Cron Triggers: BORRAR todos los triggers viejos y
 *      dejar UNO SOLO: `* * * * *`. Deploy.
 *
 * PRUEBA MANUAL: abrir la URL del Worker con ?secret=TU_SECRET&hito=<hito>
 *   (hitos válidos: checkin, staff, guests, cleaning, followups, income,
 *    income-debug, qa, retry, watchdog, autotag).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BASE = 'https://estadiasjacari.pages.dev';

/**
 * Dada la hora del tick (UTC), devuelve los endpoints que toca disparar ahora.
 * Un solo Cron Trigger `* * * * *` invoca esto cada minuto.
 */
function dueEndpoints(date) {
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const urls = [];

  if (m % 2 === 0)  urls.push(BASE + '/api/cron/bot-retry');        // cada 2 min
  if (m % 10 === 0) urls.push(BASE + '/api/cron/quote-followups');  // cada 10 min
  if (m % 30 === 0) urls.push(BASE + '/api/cron/watchdog');         // cada 30 min
  if (m === 0)      urls.push(BASE + '/api/cron/paypal-income');    // cada hora

  if (h === 0  && m === 0)  urls.push(BASE + '/api/cron/checkin-reminders'); // 6 PM HN
  if ((h === 0 && m === 30) || (h === 12 && m === 0)) urls.push(BASE + '/api/inbox/conversation-autotag'); // 6:30 PM / 6 AM HN — autotag desenlaces 2×/día (B10)
  if (h === 11 && m === 30) urls.push(BASE + '/api/inbox/bot-qa-run');       // 5:30 AM HN

  // Avisos operativos — DESCOMENTAR cuando property_contacts esté cargado:
  // if (h === 13 && m === 0)  urls.push(BASE + '/api/cron/whatsapp-operations?hito=morning-staff');    // 7 AM HN
  // if (h === 15 && m === 0)  urls.push(BASE + '/api/cron/whatsapp-operations?hito=morning-guests');   // 9 AM HN
  // if (h === 17 && m === 30) urls.push(BASE + '/api/cron/whatsapp-operations?hito=checkout-cleaning');// 11:30 HN

  return urls;
}

// Mapeo manual ?hito= → URL (usado por el handler `fetch` para test).
const MANUAL_DISPATCH = {
  checkin:        BASE + '/api/cron/checkin-reminders',
  staff:          BASE + '/api/cron/whatsapp-operations?hito=morning-staff',
  guests:         BASE + '/api/cron/whatsapp-operations?hito=morning-guests',
  cleaning:       BASE + '/api/cron/whatsapp-operations?hito=checkout-cleaning',
  followups:      BASE + '/api/cron/quote-followups',
  income:         BASE + '/api/cron/paypal-income',          // corre de verdad y cachea
  'income-debug': BASE + '/api/cron/paypal-income?debug=1',  // muestra txns Airbnb SIN escribir
  qa:             BASE + '/api/inbox/bot-qa-run',            // QA del bot
  retry:          BASE + '/api/cron/bot-retry',              // auto-recuperación del bot
  watchdog:       BASE + '/api/cron/watchdog',               // vigila que los otros crons sigan corriendo
  autotag:        BASE + '/api/inbox/conversation-autotag',  // etiqueta el desenlace de los chats (B10)
};

export default {
  // Disparo automático. UN solo trigger `* * * * *` → corre cada minuto.
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    for (const url of dueEndpoints(now)) {
      ctx.waitUntil(trigger(url, env));
    }
  },

  // Disparo manual (para probar). ?secret=... obligatorio; ?hito=... opcional.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== env.CRON_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    const hito = url.searchParams.get('hito') || 'checkin';
    const target = MANUAL_DISPATCH[hito];
    if (!target) {
      return new Response(
        JSON.stringify({
          error: `?hito=${hito} desconocido. Valores válidos: ${Object.keys(MANUAL_DISPATCH).join(', ')}`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      );
    }
    const body = await trigger(target, env);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};

async function trigger(endpointUrl, env) {
  const resp = await fetch(endpointUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CRON_SECRET },
  });
  const body = await resp.text();
  console.log(`${endpointUrl} →`, resp.status, body.slice(0, 200));
  return body;
}
