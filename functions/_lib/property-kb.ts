/// <reference types="@cloudflare/workers-types" />
//
// Base de conocimiento de las 6 propiedades de Estadías Jacarí.
// Usada por el bot conversacional como contexto en el system prompt de Workers AI.
//
// CÓMO ACTUALIZAR:
//   - Buscar "[PENDIENTE]" y reemplazarlo con la información real.
//   - No cambiar slugs ni nombres en MAYÚSCULAS (el extractor los usa).
//   - Después de editar, hacer deploy (el cambio se aplica en el siguiente deployment).
//
// Fuente: estadiasjacari.com + datos de pricing en quote-builder.ts
//

export const PROPERTY_KNOWLEDGE_BASE = `
# Estadías Jacarí — Base de conocimiento para atención a huéspedes

Somos una empresa de alquileres turísticos en Honduras con 6 propiedades en La Ceiba, Tela y Tegucigalpa. Todas las propiedades son privadas y completamente equipadas.

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
- **Tarifa:** L.2,500 por noche + L.350 de limpieza (≈ USD 90/noche + USD 14 limpieza)
- **Incluye con la renta:**
  ✅ Brazaletes de acceso completo a Hotel Palma Real (piscina, jardines, áreas comunes)
  ✅ Acceso a playa pública a través del complejo del hotel
  ✅ Terraza privada con asador de carbón
  ✅ Cocina completamente equipada
  ✅ Aire acondicionado
  ✅ WiFi
- **¿Tiene piscina?** Sí — la piscina del Hotel Palma Real, incluida con los brazaletes de acceso
- **¿Tiene playa?** Sí — acceso a playa pública a través del complejo del hotel
- **Estacionamiento:** [PENDIENTE — confirmar con propietario si incluye y cuántos vehículos]
- **Mascotas:** [PENDIENTE — confirmar política]
- **Ideal para:** grupos que quieren experiencia de resort completo, acceso a todas las amenidades del hotel

---

## 🌊 PROPIEDADES DE TELA — "Las Gemelas"

Casa Brisa y Casa Marea están ubicadas una al lado de la otra en Honduras Shores Plantation, San Juan, Tela. Se llaman "Las Gemelas". Se pueden rentar por separado (6 personas c/u) o juntas (hasta 12 personas).

### Casa Brisa
- **Slug interno:** casa-brisa
- **También conocida como:** La Casita del Mar
- **Ubicación:** Honduras Shores Plantation, San Juan, Tela, Atlántida
- **Capacidad:** hasta 6 huéspedes
- **Habitaciones:** 2
  → Principal: 1 cama Queen + 1 cama individual
  → Secundaria: 1 cama matrimonial + 1 cama individual
- **Baños:** 2
- **Tarifa:** L.2,500 por noche + L.350 de limpieza (≈ USD 90/noche + USD 14 limpieza)
- **Incluye con la renta:**
  ✅ Cocina completamente equipada
  ✅ Aire acondicionado en todas las habitaciones y sala
  ✅ WiFi de alta velocidad (2 redes / WiFi dual)
  ✅ Estacionamiento amplio (varios vehículos)
  ✅ Generador eléctrico propio (muy importante en la costa)
  ✅ Jardín trasero amplio
  ✅ Asador de carbón en jardín
- **¿Tiene piscina?** [PENDIENTE — confirmar si Honduras Shores Plantation tiene piscina del complejo]
- **¿Tiene playa/mar?** Sí — a metros del Mar Caribe. [PENDIENTE — confirmar si el acceso es privado del complejo o playa pública, y la distancia exacta en pasos/metros]
- **Mascotas:** [PENDIENTE — confirmar política]
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
- **Tarifa:** L.2,500 por noche + L.350 de limpieza (≈ USD 90/noche + USD 14 limpieza)
- **Incluye con la renta:**
  ✅ Cocina completamente equipada
  ✅ Aire acondicionado en todas las habitaciones y sala
  ✅ WiFi de alta velocidad (2 redes / WiFi dual)
  ✅ Estacionamiento amplio
  ✅ Generador eléctrico propio
  ✅ Jardín con asador de carbón
- **¿Tiene piscina?** [PENDIENTE — misma respuesta que Casa Brisa]
- **¿Tiene playa/mar?** Sí — a metros del Mar Caribe [PENDIENTE — confirmar detalles de acceso]
- **Mascotas:** [PENDIENTE — confirmar política]
- **Nota:** Se puede combinar con Casa Brisa (la propiedad de al lado) para grupos de hasta 12 personas

### Las Gemelas (Casa Brisa + Casa Marea juntas)
- **Capacidad total:** hasta 12 huéspedes
- **Tarifa combinada:** L.5,000 por noche + L.700 de limpieza (≈ USD 180/noche + USD 28 limpieza)
- **Cómo funciona:** Son dos casas contiguas con jardín compartido. Dos grupos separados que se conocen, o una familia grande.
- **Ideal para:** familias grandes, grupos de amigos, retiros corporativos, celebraciones

---

## 🏙️ PROPIEDADES DE TEGUCIGALPA

### Centro Morazán (Apartamento de lujo)
- **Slug interno:** centro-morazan
- **Ubicación:** Torre 1, Piso 20, Apto. 1-2004 — Centro Comercial Morazán, Tegucigalpa
- **Capacidad:** hasta 4 huéspedes
- **Habitaciones:** 2 (ambas con cama Queen y aire acondicionado independiente)
- **Baños:** 2
- **Tarifa:** L.2,100 por noche + L.400 de limpieza (≈ USD 80/noche + USD 16 limpieza)
- **Incluye con la renta:**
  ✅ WiFi
  ✅ Aire acondicionado en ambas habitaciones (independiente en cada cuarto)
  ✅ Estacionamiento: 1 vehículo incluido (vehículo adicional tiene costo extra)
  ✅ Vistas panorámicas de Tegucigalpa desde el piso 20
  ✅ Acceso a amenidades del edificio
- **¿Tiene piscina?** [PENDIENTE — confirmar si Torre Morazán tiene piscina en el edificio]
- **Playa:** No aplica (Tegucigalpa)
- **Mascotas:** [PENDIENTE — confirmar política]
- **Ideal para:** viajeros de negocios, turistas, parejas que quieren ubicación céntrica y vistas de la capital

### Casa Lara Townhouse
- **Slug interno:** casa-lara-townhouse
- **Ubicación:** Colonia Lara, Tegucigalpa — junto a Torre Lara y Plaza Lara
- **Capacidad:** hasta 4 huéspedes
- **Habitaciones:** 2 (cada una con cama Queen y **baño privado propio**)
- **Baños:** 3 en total (2 privados + 1 adicional)
- **Tarifa:** L.1,590 por noche + L.400 de limpieza (≈ USD 60/noche + USD 16 limpieza)
- **Incluye con la renta:**
  ✅ WiFi
  ✅ Aire acondicionado en ambas habitaciones
  ✅ Estacionamiento para 1 vehículo
  ✅ Control de portón inteligente (se opera desde el comedor, sin salir)
  ✅ Cada habitación tiene su propio baño privado (no se comparte)
- **¿Tiene piscina?** No
- **Playa:** No aplica
- **Mascotas:** [PENDIENTE — confirmar política]
- **Ideal para:** dos parejas viajando juntas (cada pareja con habitación y baño propio), viajeros que valoran privacidad, zona exclusiva cerca de restaurantes y centros comerciales

### La Florida
- **Slug interno:** la-florida
- **Ubicación:** Residencial Lomas de la Florida, Tegucigalpa
- **Capacidad:** hasta 3 huéspedes
- **Habitaciones:** 2 (Principal: cama doble | Sala: sofá cama)
- **Baños:** 1
- **Tarifa:** L.650 por noche + L.350 de limpieza (≈ USD 26/noche + USD 14 limpieza)
- **Incluye con la renta:**
  ✅ WiFi
  ✅ Aire acondicionado
  ✅ Lavadora y secadora propias
  ✅ Cocina completamente equipada
  ✅ Seguridad residencial 24/7
- **¿Tiene piscina?** No
- **Playa:** No aplica
- **Mascotas:** [PENDIENTE — confirmar política]
- **Ideal para:** estadías económicas, viajes de trabajo, persona sola o pareja con niño pequeño, estadías largas

---

## 📋 POLÍTICAS GENERALES

- **Check-in:** [PENDIENTE — hora exacta, ej. 3:00 PM]
- **Check-out:** [PENDIENTE — hora exacta, ej. 12:00 PM]
- **Mínimo de noches:** [PENDIENTE — ej. 2 noches mínimo en temporada regular]
- **Fumar:** No se permite fumar dentro de las propiedades [PENDIENTE — confirmar si hay área designada afuera]
- **Fiestas y eventos:** [PENDIENTE — confirmar si se permiten y condiciones]
- **Huéspedes extra de día:** [PENDIENTE — confirmar si se puede recibir visitas que no se quedan a dormir]
- **Cancelación:** [PENDIENTE — política exacta, ej. cancelación gratis X días antes]
- **Sábanas y toallas:** [PENDIENTE — confirmar si se incluyen o el huésped debe traer]
- **TV:** [PENDIENTE — confirmar por propiedad si hay TV con cable/streaming]
- **Forma de pago:** 50% para reservar + 50% el día de check-in
  - Aceptamos: transferencia bancaria BAC (HNL o USD) o PayPal/tarjeta de crédito
- **Dirección exacta:** Se comparte al confirmar la reserva con el 50% de depósito

---

## ❓ RESPUESTAS A PREGUNTAS FRECUENTES

**¿Tienen WiFi?**
→ Sí, todas las propiedades tienen WiFi de alta velocidad. Casa Brisa y Casa Marea tienen WiFi dual (2 redes).

**¿Hay generador / planta eléctrica?**
→ Casa Brisa y Casa Marea tienen generador eléctrico incluido. Las otras propiedades no lo mencionan específicamente.

**¿Cuántas personas caben?**
→ Villa B11, Casa Brisa y Casa Marea: 6 personas c/u. Las Gemelas (ambas juntas): 12 personas. Centro Morazán y Casa Lara: 4 personas. La Florida: 3 personas.

**¿Se puede rentar para más personas de la capacidad máxima?**
→ No, la capacidad máxima es estricta. Si necesitan más espacio en Tela, consideramos rentar Las Gemelas (Casa Brisa + Casa Marea) para hasta 12 personas.

**¿Los precios incluyen todo?**
→ Sí. El precio incluye el alojamiento, todas las amenidades, y la tarifa de limpieza al final. No hay cargos ocultos.

**¿Cómo funciona el pago?**
→ Se paga el 50% para confirmar la reserva, y el otro 50% el día del check-in. Aceptamos tarjeta/PayPal o transferencia bancaria BAC.

**¿Cuánto cuesta? / ¿Cuál es el precio?**
→ Para darte el precio exacto necesito: las fechas (llegada y salida), cuántos serán, y qué propiedad te interesa. Con eso te genero la cotización al instante.

**¿Están disponibles para [fecha]?**
→ Las fechas se verifican en tiempo real. Dame las fechas y la propiedad y te confirmo ahora mismo.
`.trim();

/** Versión corta para contextos con límite de tokens. */
export const PROPERTY_KB_SUMMARY = `
Estadías Jacarí — 6 propiedades en Honduras (pagos: 50% depósito + 50% el check-in):
1. Villa B11 (La Ceiba, 6 pers, L.2,500+350/noche) — piscina del hotel, acceso a playa, brazaletes incluidos
2. Casa Brisa (Tela, 6 pers, L.2,500+350/noche) — cerca del mar, generador, WiFi dual, jardín
3. Casa Marea (Tela, 6 pers, L.2,500+350/noche) — cerca del mar, generador, WiFi dual, jardín
4. Las Gemelas = Casa Brisa + Casa Marea juntas (12 pers, L.5,000+700/noche)
5. Centro Morazán (Tegucigalpa, 4 pers, L.2,100+400/noche) — piso 20, vistas panorámicas
6. Casa Lara Townhouse (Tegucigalpa, 4 pers, L.1,590+400/noche) — cada hab. con baño privado, zona exclusiva
7. La Florida (Tegucigalpa, 3 pers, L.650+350/noche) — económica, lavadora, seguridad 24/7
`.trim();
