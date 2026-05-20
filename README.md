# Estadías Jacarí

Sitio web de alquileres temporales en Honduras. Next.js 14 (App Router) +
TypeScript + Tailwind CSS.

## Quickstart

```bash
npm install
npm run dev          # http://localhost:3000
```

## Imágenes

El sitio usa imágenes locales en `public/images/<slug>/`. Hoy hay
**placeholders** generados automáticamente porque las imágenes reales
en Drive no son públicas.

### Opción A — descargar de Drive (cuando estén públicas)

1. En Google Drive, abre cada folder y cambia el permiso a
   **"Anyone with the link → Viewer"**. Hoy están restringidas a tu
   cuenta y por eso el script obtiene la pantalla de login en vez del
   archivo.
2. Ejecuta:
   ```bash
   npm run download-images          # respeta archivos existentes
   node scripts/download-images.mjs --force   # re-descarga
   ```
3. El script descarga via `drive.google.com/uc?export=download&id=…`,
   convierte HEIC → JPEG con sharp (calidad 85), y escribe a
   `public/images/<slug>/NN.{jpg,png}`.

### Opción B — copia local

Si tenés las fotos en tu computadora, copia cada set a la carpeta
correspondiente:

```
public/images/villa-b11/            01.jpg, 02.jpg, ... (6 mínimo)
public/images/casa-brisa/           01.png, 02.png, ...
public/images/casa-marea/           01.jpg, ...
public/images/centro-morazan/       01.jpg, ...
public/images/casa-lara-townhouse/  01.jpg, ...
public/images/la-florida/           01.jpg, ...
```

Los nombres deben coincidir con los `images: []` en
[`src/data/properties.ts`](src/data/properties.ts).

### Regenerar placeholders

```bash
node scripts/make-placeholders.mjs --force
```

## Fuentes

La fuente de marca **Le Mores** es comercial (Studio Sun) y no está en
Google Fonts. Por ahora se usa **DM Serif Display** como sustituto en
[`src/app/layout.tsx`](src/app/layout.tsx). Para cambiar, comprar la
licencia de Le Mores y reemplazar el import.

## Estructura

```
src/
  app/
    layout.tsx                       # Navbar + Footer + WhatsApp
    page.tsx                         # Home
    propiedades/[slug]/page.tsx      # Detalle (genera 6 rutas estáticas)
    globals.css                      # Tokens + utilidades de marca
    not-found.tsx
  components/
    Navbar.tsx
    Footer.tsx
    WhatsAppButton.tsx
    HeroSearch.tsx                   # buscador por ciudad
    PropertyGrid.tsx                 # grid filtrable
    PropertyCard.tsx
    GemelasBanner.tsx                # callout Casa Marea + Casa Brisa
    WhyUs.tsx
    ContactCTA.tsx
    Gallery.tsx                      # con lightbox
    ReservationForm.tsx              # form sin backend, toast de éxito
  data/
    properties.ts                    # 6 propiedades, tipado completo
public/
  logo.svg, logo.png
  branding/pattern-teal.png, pattern-gold.png
  images/<slug>/NN.{jpg,png}
scripts/
  download-images.mjs                # Drive → public/images
  make-placeholders.mjs              # genera placeholders de marca
```

## Marca

| Token       | Valor      | Uso                                  |
|-------------|------------|--------------------------------------|
| `primary`   | `#003F31`  | Verde teal — navbar, headings        |
| `secondary` | `#2B9DAE`  | Cyan — acentos, badges, hovers       |
| `accent`    | `#D0A436`  | Dorado — CTAs                        |
| `bg`        | `#F8F7F4`  | Fondo neutro cálido                  |

## Contacto cableado en código

WhatsApp: **+504 8839-0145**

## Notas

- El form de reserva no envía a ningún backend — al submit muestra un
  toast de éxito y deja el botón de WhatsApp como follow-up.
- Los mapas usan el embed simple de Google Maps (`?q=...&output=embed`)
  con búsqueda por nombre — útil para producción sin API key.
- El proyecto anterior en Vite está respaldado en
  `../estadia-jacari-vite-backup/` por si querés rescatar algo.
