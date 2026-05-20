#!/usr/bin/env node
/**
 * Generates branded placeholder images for every slot referenced
 * in src/data/properties.ts, so the site renders before the
 * real Drive images arrive.
 *
 * Each placeholder is a 1600x1200 image with the property name,
 * photo number, and a brand-color background.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, "..", "public", "images");

const SLOTS = {
  "villa-b11": { count: 6, ext: "jpg", title: "Villa B11 — Palma Real", color: "#003F31" },
  "casa-brisa": { count: 6, ext: "png", title: "Casa Brisa", color: "#2B9DAE" },
  "casa-marea": { count: 6, ext: "jpg", title: "Casa Marea", color: "#2B9DAE" },
  "centro-morazan": { count: 5, ext: "jpg", title: "Centro Morazán", color: "#003F31" },
  "casa-lara-townhouse": { count: 5, ext: "jpg", title: "Casa Lara Townhouse", color: "#D0A436" },
  "la-florida": { count: 6, ext: "jpg", title: "La Florida", color: "#6B7280" },
};

const FORCE = process.argv.includes("--force");

function pad(n) {
  return String(n).padStart(2, "0");
}

function svg(title, n, color) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${color}"/>
          <stop offset="100%" stop-color="#000"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="1200" fill="url(#g)"/>
      <g fill="#fff" font-family="Georgia, serif" text-anchor="middle">
        <text x="800" y="540" font-size="110" font-weight="700">${title}</text>
        <text x="800" y="640" font-size="48" opacity="0.85">Foto ${n}</text>
        <text x="800" y="980" font-size="32" opacity="0.65">Estadías Jacarí · imagen pendiente</text>
      </g>
    </svg>`
  );
}

async function main() {
  for (const [slug, cfg] of Object.entries(SLOTS)) {
    const dir = path.join(OUT_ROOT, slug);
    await mkdir(dir, { recursive: true });
    for (let i = 1; i <= cfg.count; i++) {
      const out = path.join(dir, `${pad(i)}.${cfg.ext}`);
      if (existsSync(out) && !FORCE) continue;
      const buf = svg(cfg.title, i, cfg.color);
      const pipeline = sharp(buf);
      const final =
        cfg.ext === "png"
          ? await pipeline.png().toBuffer()
          : await pipeline.jpeg({ quality: 80 }).toBuffer();
      await writeFile(out, final);
      console.log(`  wrote ${path.relative(process.cwd(), out)}`);
    }
  }
  console.log("\nPlaceholder images ready.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
