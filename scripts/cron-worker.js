/**
 * Cloudflare Worker — dispara el recordatorio de check-in diario.
 *
 * Llama a POST /api/cron/checkin-reminders del sitio (Pages Function) una vez al
 * día. Se separa en un Worker porque Cloudflare Pages NO soporta Cron Triggers
 * (solo Workers). El Worker no necesita base de datos: toda la lógica vive en el
 * endpoint del sitio; este solo lo "patea" con el secreto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP (una sola vez, todo desde el dashboard — no requiere wrangler local):
 *
 * 1. Cloudflare Dashboard → Workers & Pages → Create application → Create Worker.
 *    Nombre sugerido: estadia-jacari-cron. Deploy con el código de ejemplo.
 *
 * 2. Edit code → borra todo y pega ESTE archivo → Deploy.
 *
 * 3. Settings → Variables and Secrets → Add variable:
 *      Name:  CRON_SECRET
 *      Value: (EXACTAMENTE el mismo valor que pusiste en Pages como CRON_SECRET)
 *      Type:  Secret (encrypted)  → Save and deploy.
 *
 * 4. Settings → Triggers → Cron Triggers → Add Cron Trigger:
 *      Expresión: 0 0 * * *
 *      (= 00:00 UTC = 6:00 PM hora Honduras, UTC-6 sin horario de verano)
 *      Add → Deploy.
 *
 * Listo. Cada día a las 6 PM HN este Worker llama al sitio, que envía los
 * correos de check-in a las llegadas del día siguiente.
 *
 * PRUEBA MANUAL: abre la URL del Worker en el navegador con ?secret=TU_SECRET
 * (ej. https://estadia-jacari-cron.<tu-subdominio>.workers.dev/?secret=...).
 * Devuelve el resumen JSON del endpoint.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ENDPOINT = 'https://estadiasjacari.pages.dev/api/cron/checkin-reminders';

export default {
  // Disparo automático por el Cron Trigger.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(trigger(env));
  },

  // Disparo manual (para probar): requiere ?secret= que coincida con CRON_SECRET.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== env.CRON_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    const body = await trigger(env);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};

async function trigger(env) {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CRON_SECRET },
  });
  const body = await resp.text();
  console.log('checkin-reminders →', resp.status, body);
  return body;
}
