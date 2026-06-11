// Genera los íconos de la PWA (Inbox Jacarí) desde el logo blanco de marca,
// centrado sobre fondo azul marino #003F51. Usa `sharp` (ya es dependencia).
//
//   node scripts/gen-pwa-icons.mjs   (correr desde 01_sitio-web/estadia-jacari)
//
// logoFrac = qué fracción del cuadrado ocupa el logo. Maskable lleva más margen
// para caer dentro de la "zona segura" cuando Android lo recorta en círculo.

import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";

const NAVY = { r: 0, g: 63, b: 81, alpha: 1 }; // #003F51 (primary de marca)
const svg = readFileSync("public/logo-white.svg");
mkdirSync("public/icons", { recursive: true });

async function gen(size, logoFrac, out) {
  const inner = Math.round(size * logoFrac);
  const logo = await sharp(svg, { density: 384 })
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(`public/icons/${out}`);
  console.log("  ✓", out, `(${size}px, logo ${Math.round(logoFrac * 100)}%)`);
}

await gen(192, 0.62, "icon-192.png");
await gen(512, 0.62, "icon-512.png");
await gen(512, 0.52, "icon-maskable-512.png");
await gen(180, 0.66, "apple-touch-icon.png");
console.log("Íconos PWA generados en public/icons/");
