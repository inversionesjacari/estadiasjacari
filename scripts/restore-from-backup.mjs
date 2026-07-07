#!/usr/bin/env node
// scripts/restore-from-backup.mjs
//
// Restaura un backup JSON (generado por scripts/backup-worker.js) a una D1,
// vía `wrangler d1 execute`. Uso:
//
//   node scripts/restore-from-backup.mjs <backup.json> <d1-database-name> --local
//   node scripts/restore-from-backup.mjs <backup.json> <d1-database-name> --remote
//
// <d1-database-name> es el NOMBRE de la base en Cloudflare (no el binding):
// "estadias-jacari-db" o "jacari-contabilidad".
//
// --local  → restaura contra la D1 local (Miniflare, para un drill de prueba).
// --remote → restaura contra la D1 REAL en Cloudflare. Requiere el flag
//            explícito --remote-confirmado además, como segundo seguro.
//
// Asume que la TABLA YA EXISTE con el schema correcto (correr las migraciones
// de schema/*.sql primero) — este script SOLO inserta datos, no crea schema.
// Usa INSERT normal (no OR IGNORE/OR REPLACE): si una fila ya existe, falla
// fuerte en vez de fallar en silencio — mejor detenerse a que el operador
// entienda por qué que enmascarar un problema.
//
// Ver runbook completo: 03_documentos/runbook-restore-d1.md

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function usageAndExit(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    "Uso: node scripts/restore-from-backup.mjs <backup.json> <d1-database-name> --local|--remote [--remote-confirmado]",
  );
  process.exit(1);
}

const [backupPath, dbName, mode, confirmFlag] = process.argv.slice(2);
if (!backupPath || !dbName || !mode) usageAndExit("faltan argumentos");
if (mode !== "--local" && mode !== "--remote") usageAndExit("el 3er argumento debe ser --local o --remote");
if (mode === "--remote" && confirmFlag !== "--remote-confirmado") {
  usageAndExit(
    "restaurar contra D1 REMOTA requiere el 4to argumento --remote-confirmado " +
      "(seguro extra: esto puede pisar datos de producción). Leé el runbook antes de correr esto.",
  );
}

const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const tables = backup.tables ?? Object.keys(backup.data ?? {});
if (!tables.length) usageAndExit("el backup no tiene tablas (backup.tables vacío)");

/** Literal SQL seguro para un valor de D1 (JSON: string | number | null). */
function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  // Todo lo demás (incluye booleans que D1 nunca devuelve, por seguridad) va
  // como string escapado — D1/SQLite no tiene tipo boolean real.
  const s = String(value).replace(/'/g, "''");
  return `'${s}'`;
}

function buildInsertsForTable(table, rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const lines = rows.map((row) => {
    const values = columns.map((c) => sqlLiteral(row[c])).join(", ");
    return `INSERT INTO "${table}" (${colList}) VALUES (${values});`;
  });
  return lines.join("\n") + "\n";
}

const tmpDir = mkdtempSync(join(tmpdir(), "jacari-restore-"));
let totalRows = 0;
const summary = [];

for (const table of tables) {
  const rows = backup.data?.[table] ?? [];
  totalRows += rows.length;
  summary.push(`  ${table}: ${rows.length} filas`);
  if (!rows.length) continue;

  const sql = buildInsertsForTable(table, rows);
  const sqlPath = join(tmpDir, `${table}.sql`);
  writeFileSync(sqlPath, sql);

  console.log(`→ Restaurando "${table}" (${rows.length} filas)...`);
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", dbName, mode, "--file", sqlPath],
    { stdio: "inherit" },
  );
}

console.log("\n=== Restore completo ===");
console.log(summary.join("\n"));
console.log(`Total: ${totalRows} filas en ${tables.length} tablas.`);
console.log(`Backup usado: ${backupPath} (generado ${backup.generated_at ?? "?"})`);
