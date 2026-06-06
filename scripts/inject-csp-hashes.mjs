#!/usr/bin/env node
//
// scripts/inject-csp-hashes.mjs
//
// Post-build: escanea todos los .html en out/, computa SHA256 de cada
// <script> inline, y reemplaza 'unsafe-inline' por la lista de 'sha256-...'
// en la directiva script-src del CSP en out/_headers.
//
// Por qué: con `output: 'export'` de Next.js, los scripts inline del bootstrap
// cambian entre builds (referencian filenames content-hashed). Nonces no son
// posibles sin runtime. Los hashes sí — solo hay que recomputarlos por build.
//
// Resultado: CSP pasa de "tiene 'unsafe-inline' en script-src" (penalty: A) a
// "lista cerrada de hashes permitidos" (A+).
//
// Idempotente: si _headers ya tiene hashes, los reemplaza por los del build actual.
//
// Falla con código !=0 si:
//   - No encuentra out/_headers (build no se corrió antes)
//   - No encuentra la directiva script-src
//   - No encuentra ningún script inline (posible regresión del build)
//

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const OUT_DIR = "out";
const HEADERS_FILE = join(OUT_DIR, "_headers");

// Match <script ...>BODY</script> incluso multilínea. Excluye después si
// los attrs contienen src= (script externo, no hashable).
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** Walk recursivo de directorios buscando .html. */
async function findHtmlFiles(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // Skip _next/static/chunks/*.js — esos son externos, no HTML
      await findHtmlFiles(full, acc);
    } else if (e.name.endsWith(".html")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Extrae el body de cada <script> inline (sin src=) de un HTML. */
function extractInlineScripts(html) {
  const bodies = [];
  for (const m of html.matchAll(SCRIPT_TAG_RE)) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue; // external, skip
    bodies.push(body);
  }
  return bodies;
}

/** SHA256 → base64 (NO base64url — CSP requiere base64 estándar). */
function sha256Base64(text) {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

async function main() {
  // 1. Verificar que existe out/_headers
  try {
    await stat(HEADERS_FILE);
  } catch {
    console.error(`✗ No se encontró ${HEADERS_FILE}. Corre 'next build' primero.`);
    process.exit(1);
  }

  // 2. Encontrar todos los HTML y extraer scripts inline
  const htmlFiles = await findHtmlFiles(OUT_DIR);
  if (htmlFiles.length === 0) {
    console.error(`✗ No hay archivos .html en ${OUT_DIR}/`);
    process.exit(1);
  }

  const uniqueScripts = new Set();
  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    for (const body of extractInlineScripts(html)) {
      uniqueScripts.add(body);
    }
  }

  if (uniqueScripts.size === 0) {
    console.error(`✗ No se encontró ningún <script> inline en ${htmlFiles.length} archivos HTML.`);
    console.error(`  Esto es sospechoso — el bootstrap de Next.js debería estar inyectando al menos uno.`);
    process.exit(1);
  }

  // 3. Computar hashes únicos
  const hashes = new Set();
  for (const body of uniqueScripts) {
    hashes.add(`'sha256-${sha256Base64(body)}'`);
  }
  const hashList = [...hashes].sort().join(" ");

  // 4. Leer _headers, reemplazar 'unsafe-inline' en script-src
  const headers = await readFile(HEADERS_FILE, "utf8");

  // Match: "script-src 'self' 'unsafe-inline'" o "script-src 'self' 'sha256-...' 'sha256-...'"
  // (idempotente: corrida previa de este script deja hashes; los reemplazamos)
  const SCRIPT_SRC_RE = /(script-src 'self' )(?:'unsafe-inline'|'sha256-[A-Za-z0-9+/=]+'(?:\s+'sha256-[A-Za-z0-9+/=]+')*)/;

  if (!SCRIPT_SRC_RE.test(headers)) {
    console.error(`✗ No se encontró la directiva 'script-src 'self' 'unsafe-inline'' (o lista de hashes previa) en ${HEADERS_FILE}.`);
    console.error(`  Verifica el formato del CSP en public/_headers.`);
    process.exit(1);
  }

  const updated = headers.replace(SCRIPT_SRC_RE, `$1${hashList}`);

  await writeFile(HEADERS_FILE, updated, "utf8");

  console.log(`✓ Procesados ${htmlFiles.length} HTMLs.`);
  console.log(`✓ ${uniqueScripts.size} scripts inline únicos → ${hashes.size} hashes únicos.`);
  console.log(`✓ ${HEADERS_FILE} actualizado: script-src ahora sin 'unsafe-inline'.`);
}

main().catch((err) => {
  console.error("✗ Error fatal:", err);
  process.exit(1);
});
