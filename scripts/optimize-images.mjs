// Recomprime public/images/** para bajar el peso del sitio (109MB -> ~15-20MB).
//
// Reglas:
// - .jpg/.jpeg: se recomprimen IN-PLACE (mismo nombre, misma extensión) —
//   nada más en el código depende de estas rutas cambiar.
// - .png (hoy solo casa-brisa): se genera un hermano .jpg optimizado SIN
//   BORRAR el .png original. El bot de WhatsApp (functions/_lib/property-photos.ts)
//   construye URLs asumiendo la extensión .png para casa-brisa — borrar los
//   PNG le rompería el envío de fotos.
// - Idempotente: si un archivo ya está por debajo del umbral de tamaño, se
//   deja intacto (correr el script de nuevo no degrada calidad otra vez).
//
// Uso: node scripts/optimize-images.mjs [--dry-run]
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagesDir = path.join(__dirname, "..", "public", "images");

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 80;
const SIZE_THRESHOLD_BYTES = 600 * 1024; // no tocar archivos ya livianos
const dryRun = process.argv.includes("--dry-run");

let totalBefore = 0;
let totalAfter = 0;

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else {
      processFile(full);
    }
  }
}

async function processJpeg(file) {
  const before = fs.statSync(file).size;
  totalBefore += before;

  if (before < SIZE_THRESHOLD_BYTES) {
    totalAfter += before;
    return;
  }

  const meta = await sharp(file).metadata();
  const needsResize = (meta.width ?? 0) > MAX_WIDTH;

  const buffer = await sharp(file)
    .resize(needsResize ? { width: MAX_WIDTH, withoutEnlargement: true } : undefined)
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  if (buffer.length < before) {
    totalAfter += buffer.length;
    if (!dryRun) fs.writeFileSync(file, buffer);
    console.log(
      `  jpg  ${path.relative(imagesDir, file)}  ${(before / 1024).toFixed(0)}KB -> ${(buffer.length / 1024).toFixed(0)}KB`
    );
  } else {
    totalAfter += before;
  }
}

async function processCasaBrisaPng(file) {
  const dest = file.replace(/\.png$/i, ".jpg");
  if (fs.existsSync(dest)) return; // ya generado

  const before = fs.statSync(file).size;
  const buffer = await sharp(file)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  if (!dryRun) fs.writeFileSync(dest, buffer);
  console.log(
    `  png->jpg  ${path.relative(imagesDir, file)}  ${(before / 1024).toFixed(0)}KB (png intacto) -> ${(buffer.length / 1024).toFixed(0)}KB (jpg nuevo)`
  );
}

const pending = [];
function processFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    pending.push(() => processJpeg(file));
  } else if (ext === ".png") {
    pending.push(() => processCasaBrisaPng(file));
  }
}

walk(imagesDir);
for (const task of pending) {
  await task();
}

console.log(
  `\nTotal JPEG antes: ${(totalBefore / 1024 / 1024).toFixed(1)}MB, después: ${(totalAfter / 1024 / 1024).toFixed(1)}MB` +
    (dryRun ? " (dry-run, no se escribió nada)" : "")
);
