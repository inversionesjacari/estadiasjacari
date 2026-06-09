/**
 * Cloudflare Worker — dispara los crons del sitio Estadías Jacarí.
 *
 * Llama por HTTP a los endpoints `/api/cron/*` del sitio (Pages Functions) en
 * los horarios programados. Se separa en un Worker porque Cloudflare Pages NO
 * soporta Cron Triggers (solo Workers). El Worker no necesita base de datos:
 * toda la lógica vive en los endpoints del sitio; este solo los "patea" con
 * el secreto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MAPA DE TRIGGERS (todos en hora Honduras UTC-6, sin daylight saving):
 *
 *   ┌─────────────┬────────┬────────────────────────────────────────────────────┐
 *   │ Cron UTC    │ HN     │ Endpoint → Hito                                     │
 *   ├─────────────┼────────┼────────────────────────────────────────────────────┤
 *   │  0 13 * * * │  7 AM  │ /api/cron/whatsapp-operations?hito=morning-staff    │
 *   │  0 15 * * * │  9 AM  │ /api/cron/whatsapp-operations?hito=morning-guests   │
 *   │ 30 17 * * * │ 11:30  │ /api/cron/whatsapp-operations?hito=checkout-cleaning│
 *   │  0  0 * * * │  6 PM  │ /api/cron/checkin-reminders (Correo #2 + WA T-1d)  │
 *   └─────────────┴────────┴────────────────────────────────────────────────────┘
 *
 * SETUP (una sola vez por TRIGGER, todo desde el dashboard):
 *
 * 1. Cloudflare Dashboard → Workers & Pages → estadia-jacari-cron → Edit code.
 *    Pegar TODO este archivo → Deploy.
 *
 * 2. Settings → Variables and Secrets:
 *      CRON_SECRET = (el mismo valor que está en Pages como CRON_SECRET, encrypted)
 *
 * 3. Settings → Triggers → Cron Triggers → Add Cron Trigger (UNO POR EXPRESIÓN):
 *      a) Expresión: 0 13 * * *   (= 7 AM HN — limpieza + seguridad)
 *      b) Expresión: 0 15 * * *   (= 9 AM HN — huéspedes)
 *      c) Expresión: 30 17 * * *  (= 11:30 AM HN — checkout limpieza)
 *      d) Expresión: 0 0 * * *    (= 6 PM HN — recordatorio T-1 día, ya existía)
 *    Add → Deploy.
 *
 * 4. (Opcional) Eliminar el trigger viejo si quedó duplicado.
 *
 * PRUEBA MANUAL: abre la URL del Worker con ?secret=TU_SECRET&hito=<hito>:
 *   - ?secret=...&hito=checkin    → /api/cron/checkin-reminders (sin querystring extra)
 *   - ?secret=...&hito=staff      → ?hito=morning-staff
 *   - ?secret=...&hito=guests     → ?hito=morning-guests
 *   - ?secret=...&hito=cleaning   → ?hito=checkout-cleaning
 *   - (sin hito)                  → default = checkin (compatibilidad anterior)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BASE = 'https://estadiasjacari.pages.dev';

// Mapeo cron expression → URL completa del endpoint a disparar.
// Usado por el handler `scheduled` para saber qué pegarle según qué cron lo invocó.
const CRON_DISPATCH = {
  '0 0 * * *':    BASE + '/api/cron/checkin-reminders',
  '0 13 * * *':   BASE + '/api/cron/whatsapp-operations?hito=morning-staff',
  '0 15 * * *':   BASE + '/api/cron/whatsapp-operations?hito=morning-guests',
  '30 17 * * *':  BASE + '/api/cron/whatsapp-operations?hito=checkout-cleaning',
  '*/10 * * * *': BASE + '/api/cron/quote-followups',  // cada 10 min — seguimiento de cotizaciones a medias
  '0 * * * *':    BASE + '/api/cron/paypal-income',    // cada hora — ingreso Airbnb vía PayPal Transaction Search
  '30 11 * * *':  BASE + '/api/inbox/bot-qa-run',      // 5:30 AM HN — QA del bot (revisión diaria de conversaciones)
  '*/2 * * * *':  BASE + '/api/cron/bot-retry',        // cada 2 min — AUTO-RECUPERACIÓN del bot (reprocesa glitches del LLM)
};

// Mapeo manual ?hito= → URL (usado por el handler `fetch` para test).
const MANUAL_DISPATCH = {
  checkin:   BASE + '/api/cron/checkin-reminders',
  staff:     BASE + '/api/cron/whatsapp-operations?hito=morning-staff',
  guests:    BASE + '/api/cron/whatsapp-operations?hito=morning-guests',
  cleaning:  BASE + '/api/cron/whatsapp-operations?hito=checkout-cleaning',
  followups: BASE + '/api/cron/quote-followups',
  income:        BASE + '/api/cron/paypal-income',          // corre de verdad y cachea
  'income-debug': BASE + '/api/cron/paypal-income?debug=1', // muestra las txns de Airbnb que matchea, SIN escribir
  qa:            BASE + '/api/inbox/bot-qa-run',            // QA del bot: revisa conversaciones y guarda hallazgos
  retry:         BASE + '/api/cron/bot-retry',             // AUTO-RECUPERACIÓN: reprocesa la cola de glitches del LLM
};

export default {
  // Disparo automático por Cron Trigger. event.cron = la expresión que disparó.
  async scheduled(event, env, ctx) {
    const target = CRON_DISPATCH[event.cron];
    if (!target) {
      console.error(`Cron expresión desconocida: "${event.cron}"`);
      return;
    }
    ctx.waitUntil(trigger(target, env));
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
