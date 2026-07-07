/**
 * Cloudflare Worker — backup diario de AMBAS D1 (operación + contabilidad) → R2.
 *
 * v2 (2026-07-06): antes solo respaldaba 3 tablas hardcodeadas de la D1 de
 * operación y NO tocaba la contabilidad (que no tenía NINGÚN backup). Ahora:
 *   - Vuelca TODAS las tablas de cada D1, descubiertas dinámicamente vía
 *     `sqlite_master` (si mañana aparece una tabla nueva, entra sola al
 *     backup sin tener que tocar este archivo).
 *   - Respalda las DOS bases: `estadias-jacari-db` (operación, binding DB, YA
 *     existía) y `jacari-contabilidad` (binding CONTAB_DB, NUEVO en v2).
 *   - Sube a R2 en `backups/ops/YYYY-MM-DD.json` y `backups/contab/YYYY-MM-DD.json`.
 *
 * Retención: 30 días por prefijo (el worker borra backups más viejos cuando corre).
 *
 * Esto mitiga el riesgo de pérdida de D1: Cloudflare D1 tiene backups internos
 * (ver `wrangler d1 time-travel` — primera línea de defensa, restore nativo de
 * hasta 30 días) pero como capa adicional e independiente del proveedor,
 * siempre tenemos un dump JSON descargable en R2. Ver runbook de restore:
 * 03_documentos/runbook-restore-d1.md (incluye un restore drill verificado).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP / ACTUALIZACIÓN (todo desde el dashboard vía Cloudflare AI):
 *
 * Pegar el prompt de `05_automatizacion/10_prompt_backup_worker_v2.md` al chat
 * del Ask AI de Cloudflare. Bindings del Worker `estadia-jacari-backup`:
 *   - D1 `DB`        → database `estadias-jacari-db`      (YA existía, no tocar)
 *   - D1 `CONTAB_DB` → database `jacari-contabilidad`     (NUEVO en v2)
 *   - R2 `BACKUPS`   → bucket `estadias-jacari-checkin-pdfs` (prefijo `backups/`, ya existía)
 *   - Var `CRON_SECRET` → el mismo de Pages (encrypted, ya existía)
 * Cron Trigger: `0 4 * * *` (4 AM UTC = 10 PM HN previo) — ya existía, no tocar.
 *
 * PRUEBA MANUAL: abrir la URL del Worker con ?secret=CRON_SECRET — corre el
 * backup inmediatamente y devuelve resumen JSON.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RETENTION_DAYS = 30;

// Tablas internas de D1/SQLite que NUNCA hay que respaldar (no son datos del
// negocio; algunas ni siquiera son legibles con SELECT *).
const SYSTEM_TABLE_PATTERNS = [/^sqlite_/, /^_cf_/, /^d1_/];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllBackups(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== env.CRON_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    const result = await runAllBackups(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};

async function runAllBackups(env) {
  const results = {};
  // Cada base es independiente: si una falla, la otra igual se respalda (no
  // queremos que un problema en contabilidad tumbe el backup de operación).
  if (env.DB) {
    results.ops = await backupDatabase(env.DB, env.BACKUPS, 'ops').catch((err) => ({
      ok: false,
      error: err.message,
    }));
  }
  if (env.CONTAB_DB) {
    results.contab = await backupDatabase(env.CONTAB_DB, env.BACKUPS, 'contab').catch((err) => ({
      ok: false,
      error: err.message,
    }));
  }
  console.log('Backups completed:', JSON.stringify(results));
  return { ok: true, ...results };
}

/** Nombres de tabla reales de una D1 (excluye las internas de SQLite/D1). */
async function listUserTables(db) {
  const { results } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all();
  return (results ?? [])
    .map((r) => r.name)
    .filter((name) => !SYSTEM_TABLE_PATTERNS.some((re) => re.test(name)));
}

async function backupDatabase(db, bucket, prefix) {
  const startedAt = new Date().toISOString();
  const dateStr = startedAt.slice(0, 10); // YYYY-MM-DD
  const key = `backups/${prefix}/${dateStr}.json`;

  const tables = await listUserTables(db);

  const data = {};
  const counts = {};
  for (const table of tables) {
    // Nombre de tabla viene de sqlite_master (no de input externo) — seguro
    // interpolar directo, D1 no soporta bind params para nombres de tabla/columna.
    const { results } = await db.prepare(`SELECT * FROM "${table}"`).all();
    data[table] = results ?? [];
    counts[table] = data[table].length;
  }

  const payload = {
    backup_version: 2,
    generated_at: startedAt,
    tables: tables,
    counts,
    data,
  };

  await bucket.put(key, JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      generatedAt: startedAt,
      tableCount: String(tables.length),
    },
  });

  const deleted = await cleanupOldBackups(bucket, prefix);

  const result = {
    ok: true,
    key,
    tables,
    counts,
    deleted_old_backups: deleted,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  console.log(`Backup [${prefix}] completed:`, JSON.stringify(result));
  return result;
}

async function cleanupOldBackups(bucket, prefix) {
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  let deleted = 0;
  try {
    const list = await bucket.list({ prefix: `backups/${prefix}/` });
    const dateRe = new RegExp(`^backups/${prefix}/(\\d{4}-\\d{2}-\\d{2})\\.json$`);
    for (const obj of list.objects ?? []) {
      const m = obj.key.match(dateRe);
      if (m && m[1] < cutoffStr) {
        await bucket.delete(obj.key);
        deleted++;
      }
    }
  } catch (err) {
    console.error(`Cleanup failed [${prefix}]:`, err.message);
  }
  return deleted;
}
