/// <reference types="@cloudflare/workers-types" />
//
// Base de conocimiento de las 6 propiedades de Estadías Jacarí.
// Usada por el bot conversacional como contexto en el system prompt de Workers AI.
//
// CÓMO ACTUALIZAR:
//   - Editar directamente los datos que cambien.
//   - Después de editar, hacer push → Cloudflare Pages redespliega automáticamente.
//   - No cambiar los slugs (el extractor los usa para matching).
//
// Fuente: estadiasjacari.com + info confirmada por propietario (César Jauregui)
//
// ⚠️ PRECIOS: las líneas de tarifa se INTERPOLAN desde PROPERTY_PRICING
// (quote-builder.ts) — la fuente única de lo que se cobra. NO escribas montos
// a mano acá: la versión manuscrita divergió (Gemelas decía L.5,000 mientras
// el motor cobraba 4,900) y el guardia anti-drift de kb-store.test.ts lo cazó.
//

import { PROPERTY_PRICING } from "./quote-builder";

/** 4900 → "4,900" — separador de miles manual (no depende del locale). */
function fmt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Línea de tarifa uniforme, siempre desde PROPERTY_PRICING. */
function tarifa(slug: keyof typeof PROPERTY_PRICING): string {
  const p = PROPERTY_PRICING[slug];
  return `L.${fmt(p.pricePerNightHNL)} por noche + L.${fmt(p.cleaningFeeHNL)} de limpieza (≈ USD ${p.pricePerNightUSD}/noche + USD ${p.cleaningFeeUSD} limpieza)`;
}

/** Precio corto para el summary: "L.2,500+350/noche". */
function tarifaCorta(slug: keyof typeof PROPERTY_PRICING): string {
  const p = PROPERTY_PRICING[slug];
  return `L.${fmt(p.pricePerNightHNL)}+${fmt(p.cleaningFeeHNL)}/noche`;
}

export const PROPERTY_KNOWLEDGE_BASE = `
# Estadías Jacarí — Base de conocimiento para atención a huéspedes

Somos una empresa de alquileres turísticos en Honduras con 6 propiedades en La Ceiba, Tela y Tegucigalpa. Todas son propiedades privadas completamente equipadas.

---

## 🏖️ PROPIEDADES DE LA CEIBA

### Villa B11 — Hotel Palma Real
- **Slug interno:** villa-b11-palma-real
- **Ubicación:** Hotel Palma Real, La Ceiba, Atlántida
- **Capacidad:** hasta 6 huéspedes
- **Habitaciones:** 2
  → Principal: 1 cama King
  → Secundaria: 2 camas matrimoniales
- **Baños:** 1
- **Tarifa:** ${tarifa("villa-b11-palma-real")}
- **Smart TV:** Sí — conectá tu cuenta de streaming (Netflix, HBO, etc.)
- **Estacionamiento:** Incluido
- **Mascotas:** Sí se permiten (ver política de mascotas abajo)
- **Incluye con la renta:**
  ✅ Brazaletes de acceso completo a Hotel Palma Real (piscina, jardines, áreas comunes, playa)
  ✅ Terraza privada con asador de carbón
  ✅ Cocina completamente equipada
  ✅ Aire acondicionado
  ✅ WiFi
  ✅ Smart TV
- **¿Tiene piscina?** Sí ✅ — la piscina del Hotel Palma Real está incluida con los brazaletes de acceso (sin costo adicional)
- **¿Tiene playa?** Sí ✅ — acceso a las playas del hotel, incluido con la reserva (brazaletes)
- **Ideal para:** grupos que quieren la experiencia completa de resort sin pagar hotel entero

---

## 🌊 PROPIEDADES DE TELA — "Las Gemelas"

Casa Brisa y Casa Marea están ubicadas una al lado de la otra en Honduras Shores Plantation, San Juan, Tela. Se llaman "Las Gemelas". Se pueden rentar por separado (hasta 6 personas c/u) o juntas (hasta 12 personas).

### Casa Brisa
- **Slug interno:** casa-brisa
- **También conocida como:** La Casita del Mar
- **Ubicación:** Honduras Shores Plantation, San Juan, Tela, Atlántida
- **Capacidad:** hasta 6 huéspedes
- **Habitaciones:** 2
  → Principal: 1 cama Queen + 1 cama individual
  → Secundaria: 1 cama matrimonial + 1 cama individual
- **Baños:** 2
- **Tarifa:** ${tarifa("casa-brisa")}
- **Smart TV:** Sí — conectá tu cuenta de streaming (Netflix, HBO, etc.)
- **Estacionamiento:** Incluido (amplio, varios vehículos)
- **Mascotas:** Sí se permiten (ver política de mascotas abajo)
- **Incluye con la renta:**
  ✅ Cocina completamente equipada
  ✅ Aire acondicionado en todas las habitaciones y sala
  ✅ WiFi de alta velocidad (2 redes / WiFi dual)
  ✅ Estacionamiento amplio
  ✅ Generador eléctrico propio
  ✅ Jardín trasero amplio con asador de carbón
  ✅ Smart TV
- **¿Tiene piscina?** Hay piscina disponible pero es un servicio OPCIONAL y se paga directamente en el hotel (no incluido en la renta):
  → L.250 por persona de lunes a jueves
  → L.350 por persona de viernes a domingo
- **¿Tiene playa/mar?** Sí ✅ — hay dos formas de acceder:
  1. **Playa pública gratis:** rodeando el hotel por la orilla (acceso libre, sin costo)
  2. **A través del hotel:** acceso directo y más cómodo, con el mismo costo opcional de L.250-350 por persona
- **Nota:** Se puede combinar con Casa Marea (la propiedad de al lado) para grupos de hasta 12 personas

### Casa Marea
- **Slug interno:** casa-marea
- **También conocida como:** Tela Beach House
- **Ubicación:** Honduras Shores Plantation, San Juan, Tela, Atlántida
- **Capacidad:** hasta 6 huéspedes
- **Habitaciones:** 2
  → Principal: 1 cama Queen
  → Secundaria: 1 litera + 1 cama individual
- **Baños:** 2
- **Tarifa:** ${tarifa("casa-marea")}
- **Smart TV:** Sí — conectá tu cuenta de streaming
- **Estacionamiento:** Incluido (amplio)
- **Mascotas:** Sí se permiten (ver política de mascotas abajo)
- **Incluye con la renta:**
  ✅ Cocina completamente equipada
  ✅ Aire acondicionado en todas las habitaciones y sala
  ✅ WiFi de alta velocidad (2 redes / WiFi dual)
  ✅ Estacionamiento amplio
  ✅ Generador eléctrico propio
  ✅ Jardín con asador de carbón
  ✅ Smart TV
- **¿Tiene piscina?** Hay piscina disponible pero es un servicio OPCIONAL y se paga directamente en el hotel (no incluido en la renta):
  → L.250 por persona de lunes a jueves
  → L.350 por persona de viernes a domingo
- **¿Tiene playa/mar?** Sí ✅ — igual que Casa Brisa: playa pública gratis rodeando el hotel, o acceso a través del hotel con el costo opcional
- **Nota:** Se puede combinar con Casa Brisa (la propiedad de al lado) para grupos de hasta 12 personas

### Las Gemelas (Casa Brisa + Casa Marea juntas)
- **Capacidad total:** hasta 12 huéspedes
- **Tarifa combinada:** ${tarifa("las-gemelas-tela")}
- **Cómo funciona:** Dos casas contiguas con jardín compartido. Ideal para una familia grande o dos grupos que se conocen.
- **Ideal para:** familias grandes, grupos de amigos, retiros corporativos

---

## 🏙️ PROPIEDADES DE TEGUCIGALPA

### Centro Morazán (Apartamento de lujo)
- **Slug interno:** centro-morazan
- **Ubicación:** Torre 1, Piso 20, Apto. 1-2004 — Bulevar Morazán, Tegucigalpa
- **Capacidad:** hasta 6 huéspedes
- **Habitaciones:** 2 — Principal: 1 cama Queen · Secundaria: 1 cama Queen + 1 cama adicional (3 camas en total, hasta 6 personas). A/C independiente en cada habitación
- **Baños:** 2
- **Tarifa:** ${tarifa("centro-morazan")}
- **Smart TV:** Sí — conectá tu cuenta de streaming
- **Estacionamiento:** 1 vehículo incluido (vehículo adicional tiene costo extra)
- **Mascotas:** Sí se permiten (ver política de mascotas abajo)
- **Incluye con la renta:**
  ✅ WiFi
  ✅ Aire acondicionado en ambas habitaciones (independiente en cada cuarto)
  ✅ Estacionamiento para 1 vehículo
  ✅ Vistas panorámicas de Tegucigalpa desde el piso 20
  ✅ Acceso a amenidades del edificio
  ✅ Smart TV
- **¿Tiene piscina?** No se incluye (verificar disponibilidad del edificio directamente)
- **Playa:** No aplica (Tegucigalpa)
- **Ideal para:** viajeros de negocios, turistas, parejas que buscan ubicación céntrica y vistas espectaculares de la capital

### Casa Lara Townhouse
- **Slug interno:** casa-lara-townhouse
- **Ubicación:** Colonia Lara, Tegucigalpa — junto a Torre Lara y Plaza Lara
- **Capacidad:** hasta 4 huéspedes
- **Habitaciones:** 2 (cada una con cama Queen y **baño privado propio**)
- **Baños:** 3 en total (2 privados + 1 adicional)
- **Tarifa:** ${tarifa("casa-lara-townhouse")}
- **Smart TV:** Sí — conectá tu cuenta de streaming
- **Estacionamiento:** Incluido (1 vehículo)
- **Mascotas:** Sí se permiten (ver política de mascotas abajo)
- **Incluye con la renta:**
  ✅ WiFi
  ✅ Aire acondicionado en ambas habitaciones
  ✅ Estacionamiento para 1 vehículo
  ✅ Control de portón inteligente (se opera desde el comedor, sin salir)
  ✅ Cada habitación tiene su propio baño privado
  ✅ Smart TV
- **¿Tiene piscina?** No
- **Playa:** No aplica
- **Ideal para:** dos parejas viajando juntas, viajeros que valoran privacidad, zona exclusiva cerca de restaurantes y centros comerciales

### La Florida
- **Slug interno:** la-florida
- **Ubicación:** Residencial Lomas de la Florida, Tegucigalpa
- **Capacidad:** hasta 3 huéspedes
- **Habitaciones:** 2 (Principal: cama doble | Sala: sofá cama)
- **Baños:** 1
- **Tarifa:** ${tarifa("la-florida")}
- **Smart TV:** Sí — conectá tu cuenta de streaming
- **Estacionamiento:** No incluido (zona residencial privada con acceso controlado)
- **Mascotas:** Sí se permiten (ver política de mascotas abajo)
- **Incluye con la renta:**
  ✅ WiFi
  ✅ Aire acondicionado
  ✅ Lavadora y secadora propias
  ✅ Cocina completamente equipada
  ✅ Seguridad residencial 24/7
  ✅ Smart TV
- **¿Tiene piscina?** No
- **Playa:** No aplica
- **Ideal para:** estadías económicas, viajes de trabajo, persona sola o pareja, estadías largas

---

## 📋 POLÍTICAS GENERALES

### Horarios
- **Check-in:** 3:00 PM (aplica en todos los alojamientos)
- **Check-out:** 11:00 AM (aplica en todos los alojamientos)
- Check-in anticipado o check-out tardío sujetos a disponibilidad — consultar con anticipación

### Smart TV
- Todas las propiedades tienen Smart TV
- El huésped conecta su propia cuenta de Netflix, HBO, Disney+, etc.
- No incluimos suscripciones de streaming

### Estacionamiento
- Incluido en Villa B11, Casa Brisa, Casa Marea, Centro Morazán (1 carro, extra tiene costo), Casa Lara Townhouse
- La Florida: no incluye estacionamiento

### Mascotas 🐾
- Se permiten mascotas en TODAS las propiedades
- Mensaje estándar a usar con el huésped: *"Por esta ocasión podemos hacer una excepción, solo le solicitamos a nuestros huéspedes hacerse responsables por cualquier daño que puedan llegar a ocasionar y comunicarlo de inmediato con nosotros."*
- Si el huésped pregunta si se permiten mascotas, usar exactamente ese tono.

### Fiestas y eventos
- PROHIBIDAS en todas las propiedades sin excepción
- No se permiten fiestas, eventos sociales, quinceañeras, bodas ni reuniones masivas

### Fumar
- No se permite fumar dentro de las propiedades

### Cancelación
- El 50% inicial de depósito **no es reembolsable** (se pierde si cancela)
- **Excepción:** Si el huésped cancela con al menos **1 semana de anticipación**, se realiza **reembolso completo**
- El 50% restante simplemente no se cobra si no se completa la estadía
- No hay penalidades adicionales

### Forma de pago
- 50% para confirmar la reserva (depósito)
- 50% restante el día del check-in
- Aceptamos: tarjeta de crédito / PayPal (link de pago instantáneo) o transferencia bancaria BAC (HNL o USD)

### Dirección exacta
- Se comparte únicamente al confirmar la reserva con el 50% de depósito

---

## ❓ RESPUESTAS A PREGUNTAS FRECUENTES

**¿A qué hora es el check-in?**
→ El check-in es a las 3:00 PM. El check-out es a las 11:00 AM. Aplica en todos nuestros alojamientos.

**¿Tienen WiFi?**
→ Sí, todas las propiedades tienen WiFi de alta velocidad. Casa Brisa y Casa Marea tienen WiFi dual (2 redes).

**¿Tienen TV?**
→ Sí, todas las propiedades tienen Smart TV. El huésped conecta su propia cuenta de streaming (Netflix, HBO, Disney+, etc.).

**¿Se permiten mascotas?**
→ Sí, por esta ocasión podemos hacer una excepción. Solo les solicitamos hacerse responsables por cualquier daño que puedan ocasionar y comunicarlo de inmediato con nosotros.

**¿Hay piscina en Tela (Casa Brisa / Casa Marea)?**
→ Hay piscina disponible, pero es un servicio opcional que se paga directamente en el hotel: L.250 por persona de lunes a jueves, y L.350 de viernes a domingo. No está incluida en la renta de la casa.

**¿Hay piscina en Villa B11 (La Ceiba)?**
→ Sí ✅ — el acceso a la piscina del Hotel Palma Real está incluido con la renta. Le proporcionamos brazaletes al inicio de su estadía.

**¿Cómo se llega a la playa en Tela?**
→ Pueden acceder de dos maneras: (1) Por la playa pública rodeando el hotel, sin ningún costo adicional. (2) A través del hotel de forma más directa y cómoda, con el mismo costo opcional de la piscina (L.250-350 por persona).

**¿Se permiten fiestas o eventos?**
→ No, las fiestas y eventos están prohibidos en todas nuestras propiedades.

**¿Cuál es la política de cancelación?**
→ Si cancelás con al menos una semana de anticipación, te hacemos el reembolso completo. Si es después de esa fecha, el depósito inicial del 50% no es reembolsable. No hay penalidades adicionales.

**¿Hay generador / planta eléctrica?**
→ Casa Brisa y Casa Marea tienen generador eléctrico propio incluido (muy útil en la costa).

**¿Cuántas personas caben?**
→ Villa B11: 6 personas. Casa Brisa: 6 personas. Casa Marea: 6 personas. Las Gemelas (ambas juntas): 12 personas. Centro Morazán: 6 personas. Casa Lara: 4 personas. La Florida: 3 personas.

**¿Se puede ir más gente de la capacidad máxima?**
→ La capacidad cuenta por camas: los adultos ocupan el cupo completo, pero si un par de niños pequeños comparten cama con ustedes, pueden entrar por encima del número publicado (por ejemplo, 11 adultos + 2 niños entran en Las Gemelas, que aloja 12). Si el grupo es de puros adultos, el cupo es estricto. Para grupos grandes en Tela, Las Gemelas (Casa Brisa + Casa Marea juntas) alojan hasta 12.

**¿Los precios incluyen todo?**
→ Sí. El precio incluye el alojamiento, todas las amenidades listadas y la tarifa de limpieza. No hay cargos ocultos.

**¿Cuánto cuesta? / ¿Cuál es el precio?**
→ Para darte la cotización exacta necesito: las fechas de llegada y salida, cuántos serán, y qué propiedad te interesa. Con eso te calculo el total al instante.

**¿Están disponibles para [fecha]?**
→ Las fechas se verifican en tiempo real. Dame la propiedad y las fechas y te confirmo disponibilidad ahora mismo.
`.trim();

/** Versión corta para contextos con límite de tokens. */
export const PROPERTY_KB_SUMMARY = `
Estadías Jacarí — 6 propiedades en Honduras:
1. Villa B11 (La Ceiba, 6 pers, ${tarifaCorta("villa-b11-palma-real")}) — piscina + playa incluidas (brazaletes del hotel), Smart TV, estacionamiento
2. Casa Brisa (Tela, 6 pers, ${tarifaCorta("casa-brisa")}) — cerca del mar, piscina opcional (L.250-350/pers), playa pública gratis, generador, WiFi dual, Smart TV
3. Casa Marea (Tela, 6 pers, ${tarifaCorta("casa-marea")}) — igual que Casa Brisa, juntas forman Las Gemelas (hasta 12 personas)
4. Centro Morazán (Tegucigalpa, 6 pers, ${tarifaCorta("centro-morazan")}) — piso 20, vistas panorámicas, Smart TV, 1 estacionamiento incluido
5. Casa Lara Townhouse (Tegucigalpa, 4 pers, ${tarifaCorta("casa-lara-townhouse")}) — cada hab. con baño privado, zona exclusiva, Smart TV
6. La Florida (Tegucigalpa, 3 pers, ${tarifaCorta("la-florida")}) — económica, lavadora, Smart TV, seguridad 24/7
Check-in 3 PM · Check-out 11 AM · Mascotas OK (con responsabilidad) · Fiestas PROHIBIDAS · Cancelación gratis con 1 semana de anticipación
`.trim();
