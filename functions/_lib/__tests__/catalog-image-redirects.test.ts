// Guard del shim `public/_redirects` que sostiene la tarjeta NATIVA del catálogo
// de WhatsApp (Commerce Manager, catalog_id 4505514079768766).
//
// Contexto: el catálogo congeló URLs de imagen `.png` bajo /images/<prop>/NN.png.
// La optimización de imágenes (overhaul 6-8 jul) dejó solo `.jpg` en 4 propiedades
// → las `.png` daban 404 → Meta marcaba el producto "Obsoleto" → error 131009 al
// enviar la tarjeta. El fix es un 301 de cada `.png` vieja a su `.jpg` real.
//
// Este test es el candado: si una futura optimización/renombrado borra el `.jpg`
// destino de algún redirect, o alguien saca la regla de una propiedad del catálogo,
// CI falla ACÁ en vez de que el bot vuelva a caer a texto en silencio semanas después.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// functions/_lib/__tests__ → 3 niveles arriba está la raíz del sitio.
const REPO_ROOT = resolve(here, "../../..");
const PUBLIC_DIR = resolve(REPO_ROOT, "public");
const REDIRECTS_FILE = resolve(PUBLIC_DIR, "_redirects");

// Las 4 propiedades cuyas `.png` congeló el catálogo y borró la optimización.
// casa-brisa NO va: conserva sus `.png` reales (el bot depende de esa extensión).
const CATALOG_PROPS = ["villa-b11", "centro-morazan", "casa-marea", "casa-lara-townhouse"];

interface Rule {
  from: string;
  to: string;
  status: string;
}

function parseRedirects(text: string): Rule[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => {
      const [from, to, status] = l.split(/\s+/);
      return { from, to, status };
    });
}

describe("_redirects: shim del catálogo de WhatsApp", () => {
  const text = readFileSync(REDIRECTS_FILE, "utf8");
  const rules = parseRedirects(text);

  it("hay reglas de redirect (el archivo no quedó vacío)", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it("cada destino .jpg existe en public/ — si falta, la tarjeta del catálogo se rompe de nuevo (131009)", () => {
    const missing: string[] = [];
    for (const r of rules) {
      // `to` es una ruta absoluta del sitio (/images/.../NN.jpg) → archivo en public/.
      const target = resolve(PUBLIC_DIR, "." + r.to);
      if (!existsSync(target)) missing.push(r.to);
    }
    expect(missing, `destinos faltantes en public/: ${missing.join(", ")}`).toEqual([]);
  });

  it("cubre las 4 propiedades del catálogo cuyas .png borró la optimización", () => {
    for (const prop of CATALOG_PROPS) {
      const covered = rules.some((r) => r.from.startsWith(`/images/${prop}/`));
      expect(covered, `falta el redirect de ${prop}`).toBe(true);
    }
  });

  it("toda regla es un 301 de .png → .jpg (forma esperada del shim)", () => {
    for (const r of rules) {
      expect(r.from.endsWith(".png"), `origen no es .png: ${r.from}`).toBe(true);
      expect(r.to.endsWith(".jpg"), `destino no es .jpg: ${r.to}`).toBe(true);
      expect(r.status, `status inesperado en ${r.from}`).toBe("301");
    }
  });
});
