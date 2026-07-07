// Genera public/og/<slug>.jpg (1200x630) desde la foto de portada de cada
// propiedad, para usar como OpenGraph/Twitter image al compartir el link
// de una propiedad. Se corre a mano (una vez, y de nuevo si cambia la foto
// de portada); el resultado se commitea junto al código.
//
// El mapa de portadas debe reflejar images[0] de cada propiedad en
// src/data/properties.ts — si cambia el orden de fotos ahí, actualizar acá.
//
// Uso: node scripts/generate-og-images.mjs
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const outDir = path.join(publicDir, "og");

const covers = {
  "villa-b11-palma-real": "/images/villa-b11/06.jpg",
  "casa-brisa": "/images/casa-brisa/01.png", // sharp lee PNG y exporta JPEG sin problema
  "casa-marea": "/images/casa-marea/11.jpg",
  "centro-morazan": "/images/centro-morazan/01.jpg",
  "casa-lara-townhouse": "/images/casa-lara-townhouse/01.jpg",
  "la-florida": "/images/la-florida/03.jpg",
};

fs.mkdirSync(outDir, { recursive: true });

for (const [slug, cover] of Object.entries(covers)) {
  const src = path.join(publicDir, cover.replace(/^\//, ""));
  const dest = path.join(outDir, `${slug}.jpg`);
  await sharp(src)
    .resize(1200, 630, { fit: "cover", position: "attention" })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`✓ og/${slug}.jpg (${kb} KB)`);
}
