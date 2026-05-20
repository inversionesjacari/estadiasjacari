# Estadías Jacarí — Documentación del Proyecto Web

> Última actualización: 20 de mayo de 2026

---

## Qué es este proyecto

Sitio web de alquileres temporales para **Estadías Jacarí**, empresa hondureña con propiedades en La Ceiba, Tela y Tegucigalpa. El objetivo del sitio es mostrar las propiedades, generar confianza y convertir visitantes en consultas por WhatsApp o correo.

El sitio **no tiene sistema de reservas en línea** — el contacto y la confirmación se manejan manualmente vía WhatsApp o email.

---

## Stack tecnológico

| Tecnología | Uso |
|---|---|
| **Next.js 14** (App Router) | Framework principal |
| **TypeScript** | Tipado en todo el proyecto |
| **Tailwind CSS** | Estilos utilitarios + tokens de marca |
| **next/image** | Optimización automática de imágenes |
| **Google Fonts** | DM Serif Display + Plus Jakarta Sans |

**Puerto de desarrollo:** `3017`

**Arrancar el servidor:**
```bash
cd "/Users/cesarjauregui/Desktop/carpeta sin título 2/estadia-jacari"
npm run dev
```

---

## Estructura de archivos

```
estadia-jacari/
├── public/
│   ├── logo.jpg              ← Logo 9 (marca geométrica, usada en navbar)
│   ├── logo-white.svg        ← Logo 14 SVG (fill blanco, usada en footer)
│   ├── logo.png / logo.svg   ← Versiones adicionales del logo
│   └── images/
│       ├── villa-b11/        ← 15 fotos (.jpg)
│       ├── casa-brisa/       ← 12 fotos (.png)
│       ├── casa-marea/       ← 16 fotos (.jpg)
│       ├── centro-morazan/   ← 11 fotos (.jpg)
│       ├── casa-lara-townhouse/ ← 15 fotos (.jpg)
│       └── la-florida/       ← 6 fotos (.jpg)
├── src/
│   ├── app/
│   │   ├── globals.css       ← Variables CSS de marca + clases utilitarias
│   │   ├── layout.tsx        ← Layout raíz: fuentes, Navbar, WhatsAppButton, Footer
│   │   ├── page.tsx          ← Página de inicio
│   │   ├── not-found.tsx     ← Página 404
│   │   └── propiedades/[slug]/page.tsx ← Detalle de propiedad
│   ├── components/
│   │   ├── Navbar.tsx        ← Header fijo con scroll effect
│   │   ├── Footer.tsx        ← Footer oscuro con logo blanco e íconos sociales
│   │   ├── PropertyGrid.tsx  ← Grid con filtro por ciudad (client component)
│   │   ├── PropertyCard.tsx  ← Tarjeta de propiedad
│   │   ├── Gallery.tsx       ← Galería con lightbox (client component)
│   │   ├── ReservationForm.tsx ← Formulario lateral en detalle (client component)
│   │   ├── WhatsAppButton.tsx ← Botón flotante de WhatsApp (global)
│   │   ├── GemelasBanner.tsx ← Banner especial "Las Gemelas de Tela"
│   │   ├── WhyUs.tsx         ← Sección "Por qué elegirnos"
│   │   ├── ContactCTA.tsx    ← Sección de contacto final
│   │   └── HeroSearch.tsx    ← Hero de página de inicio
│   └── data/
│       └── properties.ts     ← Fuente única de verdad de las 6 propiedades
```

---

## Sistema de marca (Brand System)

### Paleta de colores

| Token | Hex | Uso |
|---|---|---|
| `primary` | `#003F51` | Azul marino oscuro — fondo footer, textos principales, botones |
| `secondary` | `#289DAE` | Teal/verde agua — etiquetas, acentos secundarios |
| `accent` | `#D2A436` | Dorado — botones de acción principal, highlights |
| `bg` | `#F8F7F4` | Beige muy suave — fondo general de la página |
| `muted` | `#6B7280` | Gris — texto secundario |

Definidos en `globals.css` como variables CSS y en `tailwind.config.ts` como tokens.

### Tipografía

- **DM Serif Display** — títulos, nombre de la empresa, headings (`font-display`)
- **Plus Jakarta Sans** — cuerpo de texto, navegación, etiquetas
- Ambas via Google Fonts, cargadas en `layout.tsx`

> La fuente original de la marca es "Le Mores" (comercial). DM Serif Display fue elegida como sustituto gratuito que mantiene la elegancia del serif.

### Logos

- **Navbar:** `logo.jpg` (Logo 9 — marca geométrica circular, visible sobre fondo blanco)
- **Footer:** `logo-white.svg` (Logo 14 — SVG con `fill: #fff`, se ve blanco directamente sobre el fondo azul oscuro sin necesidad de caja blanca)

---

## Las 6 propiedades

| # | Nombre | Ciudad | Tipo | Capacidad |
|---|---|---|---|---|
| 1 | Villa B11 — Palma Real | La Ceiba | Villa en complejo hotelero | 6 personas |
| 2 | Casa Brisa | Tela | Casa residencial | 6 personas |
| 3 | Casa Marea | Tela | Casa residencial | 6 personas |
| 4 | Centro Morazán | Tegucigalpa | Apartamento (piso 20) | 4 personas |
| 5 | Casa Lara Townhouse | Tegucigalpa | Townhouse | 4 personas |
| 6 | La Florida | Tegucigalpa | Apartamento | 3 personas |

Casa Brisa y Casa Marea forman **"Las Gemelas de Tela"** — pueden rentarse juntas para hasta 12 personas en la misma propiedad.

---

## Decisiones importantes del proyecto

### 1. Sin sistema de reservas en línea
El formulario lateral en cada propiedad **no procesa pagos ni reservas reales** — genera un mensaje de WhatsApp preformateado. La conversión y el cierre se hacen manualmente. Esto fue una decisión deliberada para simplificar el lanzamiento y mantener el trato personalizado como ventaja competitiva.

### 2. Imágenes locales, no CDN
Todas las fotos se descargaron desde Google Drive y se almacenan en `public/images/<slug>/`. Esto evita dependencia de permisos externos y garantiza disponibilidad. Las fotos originales eran HEIC (iPhone) y se convirtieron a JPG/PNG usando el comando `sips` de macOS (el módulo `sharp` no soporta HEIC en este entorno).

### 3. Orden de fotos curado manualmente
El orden de las imágenes en `properties.ts` importa — la primera foto es la portada en la tarjeta y en la galería. Decisiones tomadas:
- **Casa Marea:** `11.jpg` primero (exterior de la casa), `12.jpg` segundo (foto de playa) — se descartó poner el baño de portada
- **Villa B11:** `06.jpg` primero (mejor foto exterior)
- **La Florida:** `03.jpg` primero (sala/espacio más atractivo)

### 4. Banner "Las Gemelas" solo en Tela
El `GemelasBanner` — que promueve rentar ambas casas juntas para grupos de más de 6 — solo aparece cuando el filtro activo es "Tela". Mostrarlo en todas las ciudades no tenía sentido contextual.

### 5. Botón flotante de WhatsApp global
`WhatsAppButton.tsx` está en el `layout.tsx` raíz — aparece en todas las páginas, siempre visible. Es el canal principal de conversión. El número es `+504 8839-0145`.

### 6. Footer: patrón tileado descartado
Se intentó usar patrones repetidos (PNG tileados) en el footer pero las juntas entre tiles eran visibles y lucían mal. Se reemplazó por un SVG decorativo custom (3 arcos concéntricos) ubicado en la esquina inferior derecha del footer — aparece una sola vez, sin repetición.

### 7. Logo en footer: SVG blanco directo, sin caja
La primera versión del footer envolvía el logo en una caja blanca redondeada. Se cambió a usar `logo-white.svg` (Logo 14 con fill blanco) directamente sobre el fondo azul oscuro — más limpio, más sofisticado.

### 8. Íconos sociales en footer
El footer tiene íconos de **Facebook** e **Instagram** a la derecha del logo. El botón de WhatsApp solo existe como flotante global — no se duplica en el footer. Links:
- Facebook: `https://www.facebook.com/profile.php?id=100078132980551`
- Instagram: `https://www.instagram.com/estadiasjacari`

### 9. Hero image: foto de playa, no de interiores
La imagen principal del hero en la página de inicio usa `/images/casa-marea/12.jpg` (foto de playa). Se descartaron fotos de baños o interiores genéricos para la primera impresión.

### 10. Navbar siempre blanca
El header es blanco en todo momento (con sombra al hacer scroll), no transparente sobre el hero. Esto evita problemas de legibilidad con cualquier foto de fondo y mantiene el logo visible en todo momento.

---

## Contacto configurado en el sitio

| Canal | Valor |
|---|---|
| WhatsApp | +504 8839-0145 |
| Email | hola@estadiasjacari.com |
| Facebook | facebook.com/profile.php?id=100078132980551 |
| Instagram | instagram.com/estadiasjacari |

---

## Cosas pendientes / posibles mejoras futuras

- [ ] SEO: meta tags Open Graph para que los links compartan bien en redes sociales
- [ ] Analytics: agregar Google Analytics o similar
- [ ] Dominio propio y deploy en producción (Vercel es la opción más natural para Next.js)
- [ ] Sistema de precios: actualmente las propiedades no tienen precio visible — se consulta por WhatsApp
- [ ] Disponibilidad en tiempo real: actualmente no existe, se maneja manualmente
- [ ] Versión en inglés para turistas extranjeros
