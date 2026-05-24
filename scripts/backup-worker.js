/**
 * Cloudflare Worker — backup diario de D1 → R2.
 *
 * Cada día a las 4 AM UTC (10 PM HN), exporta a JSON las tablas críticas:
 *   - reservations
 *   - paypal_webhook_log (últimos 30 días)
 *   - property_checkin_info
 * y sube el archivo a R2 con nombre `backups/YYYY-MM-DD.json`.
 *
 * Retención: 30 días (el worker borra backups más viejos cuando corre).
 *
 * Esto mitiga el riesgo de pérdida de D1: Cloudflare D1 tiene backups internos
 * pero NO un botón "restore from N days ago" disponible al usuario hoy. Con
 * esto siempre tenemos un dump descargable en R2.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP (una sola vez, todo desde el dashboard via Cloudflare AI):
 *
 * Pegar el prompt de `scripts/prompts/setup-backup-worker.md` al chat del
 * Ask AI de Cloudflare. El AI hace:
 *
 *   1. Crea Worker `estadia-jacari-backup`.
 *   2. Pega ESTE archivo como código del Worker.
 *   3. Bindings:
 *        - D1: variable name `DB`, database `estadias-jacari-db`
 *        - R2: variable name `BACKUPS`, bucket `estadias-jacari-checkin-pdfs`
 *          (reusar el bucket existente, prefijo `backups/`)
 *   4. Cron Triggers: `0 4 * * *` (4 AM UTC = 10 PM HN previo)
 *   5. Deploy.
 *
 * PRUEBA MANUAL: abre la URL del Worker con ?secret=CRON_SECRET — corre el
 * backup inmediatamente y devuelve resumen JSON.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RETENTION_DAYS = 30;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== env.CRON_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    const result = await runBackup(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};

async function runBackup(env) {
  const startedAt = new Date().toISOString();
  const dateStr = startedAt.slice(0, 10); // YYYY-MM-DD
  const key = `backups/${dateStr}.json`;

  // 1. Volcar tablas
  const [reservations, webhookLog, checkinInfo] = await Promise.all([
    env.DB.prepare('SELECT * FROM reservations ORDER BY id ASC').all(),
    env.DB.prepare(
      `SELECT * FROM paypal_webhook_log
        WHERE received_at > datetime('now', '-30 days')
        ORDER BY id ASC`,
    ).all(),
    env.DB.prepare('SELECT * FROM property_checkin_info').all(),
  ]);

  const payload = {
    backup_version: 1,
    generated_at: startedAt,
    counts: {
      reservations: reservations.results?.length ?? 0,
      paypal_webhook_log: webhookLog.results?.length ?? 0,
      property_checkin_info: checkinInfo.results?.length ?? 0,
    },
    data: {
      reservations: reservations.results ?? [],
      paypal_webhook_log: webhookLog.results ?? [],
      property_checkin_info: checkinInfo.results ?? [],
    },
  };

  // 2. Subir a R2
  await env.BACKUPS.put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      generatedAt: startedAt,
      reservationsCount: String(payload.counts.reservations),
    },
  });

  // 3. Limpieza de backups viejos (>RETENTION_DAYS)
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  let deleted = 0;
  try {
    const list = await env.BACKUPS.list({ prefix: 'backups/' });
    for (const obj of list.objects ?? []) {
      // Key format: backups/YYYY-MM-DD.json — extraer la fecha
      const m = obj.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (m && m[1] < cutoffStr) {
        await env.BACKUPS.delete(obj.key);
        deleted++;
      }
    }
  } catch (err) {
    console.error('Cleanup failed:', err.message);
  }

  const result = {
    ok: true,
    key,
    counts: payload.counts,
    deleted_old_backups: deleted,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  console.log('Backup completed:', JSON.stringify(result));
  return result;
}
