export interface Bedroom {
  name: string;
  beds: string;
}

export interface Property {
  slug: string;
  name: string;
  type: string;
  location: string;
  city: "La Ceiba" | "Tela" | "Tegucigalpa";
  capacity: number;
  bedrooms: Bedroom[];
  bathrooms: number;
  amenities: string[];
  highlights: string[];
  description: string[];
  images: string[];
  mapEmbed: string;
  gemelas?: boolean;
  pricePerNightUSD: number;
  cleaningFeeUSD: number;
  pricePerNightHNL: number;
  cleaningFeeHNL: number;
}

export const CITIES = ["La Ceiba", "Tela", "Tegucigalpa"] as const;

export const properties: Property[] = [
  // ──────────────────────────────────────────────────────────
  // 1. VILLA B11 — HOTEL PALMA REAL
  // ──────────────────────────────────────────────────────────
  {
    slug: "villa-b11-palma-real",
    name: "Villa B11 — Palma Real",
    type: "Villa en complejo hotelero",
    location: "Hotel Palma Real, La Ceiba, Atlántida",
    city: "La Ceiba",
    capacity: 6,
    bedrooms: [
      { name: "Habitación principal", beds: "1 cama King" },
      { name: "Habitación secundaria", beds: "2 camas matrimoniales" },
    ],
    bathrooms: 1,
    amenities: [
      "Cocina completamente equipada",
      "Aire acondicionado",
      "Asador de carbón en terraza",
      "WiFi",
      "Acceso a piscina incluido (brazaletes)",
      "Acceso a playa pública",
      "Todas las áreas del hotel incluidas",
    ],
    highlights: [
      "Villa privada con experiencia de resort incluida",
      "Brazaletes de acceso a todas las instalaciones del hotel",
      "Acceso a playa pública a metros",
      "Capacidad para 6 personas",
    ],
    description: [
      "Villa B11 no es solo un lugar donde quedarse — es una villa privada que viene con todo el Hotel Palma Real incluido. Con tu reserva, cada huésped recibe brazaletes con acceso completo a las instalaciones del hotel: piscina, áreas comunes, jardines y playa.",
      "La villa cuenta con 2 habitaciones equipadas para el descanso total, cocina completamente equipada para que puedas cocinar lo que quieras, y una terraza privada con asador de carbón perfecta para las tardes en La Ceiba.",
      "Ubicada estratégicamente en La Ceiba, Atlántida, es el punto de partida ideal para explorar la costa caribeña hondureña o simplemente desconectarte del mundo.",
    ],
    images: [
      "/images/villa-b11/06.jpg",
      "/images/villa-b11/15.jpg",
      "/images/villa-b11/01.jpg",
      "/images/villa-b11/02.jpg",
      "/images/villa-b11/03.jpg",
      "/images/villa-b11/04.jpg",
      "/images/villa-b11/05.jpg",
      "/images/villa-b11/07.jpg",
    ],
    mapEmbed:
      "https://www.google.com/maps?q=Hotel+Palma+Real+La+Ceiba+Honduras&output=embed",
    pricePerNightUSD: 90,
    cleaningFeeUSD: 14,
    pricePerNightHNL: 2500,
    cleaningFeeHNL: 350,
  },

  // ──────────────────────────────────────────────────────────
  // 2. CASA BRISA — LAS GEMELAS DE TELA
  // ──────────────────────────────────────────────────────────
  {
    slug: "casa-brisa",
    name: "Casa Brisa",
    type: "Casa residencial",
    location: "Honduras Shores Plantation, San Juan, Tela, Atlántida",
    city: "Tela",
    capacity: 6,
    bedrooms: [
      {
        name: "Habitación principal",
        beds: "1 cama Queen + 1 cama individual",
      },
      {
        name: "Habitación secundaria",
        beds: "1 cama matrimonial + 1 cama individual",
      },
    ],
    bathrooms: 2,
    amenities: [
      "Cocina completamente equipada",
      "Aire acondicionado en todas las habitaciones y sala",
      "Asador de carbón en jardín trasero",
      "Jardín trasero amplio",
      "WiFi dual (2 redes)",
      "Estacionamiento amplio",
      "Generador eléctrico",
    ],
    highlights: [
      "Ubicada en Honduras Shores Plantation",
      "Playa a pasos — Tela, Atlántida",
      "Generador eléctrico incluido",
      "Se puede rentar junto a Casa Marea para 12 personas",
    ],
    description: [
      "Casa Brisa es tu base perfecta en Tela, ubicada dentro de Honduras Shores Plantation a pasos del mar. Tiene todo listo para que la única decisión sea quién cocina el primer día.",
      "Con cocina completamente equipada, dos habitaciones con aire acondicionado, jardín con asador y generador eléctrico, no tendrás que preocuparte por nada durante tu estadía.",
      "Casa Brisa es parte de Las Gemelas de Tela junto a Casa Marea — si son más de 6, pueden rentar ambas casas para hasta 12 personas en la misma propiedad.",
    ],
    images: [
      "/images/casa-brisa/01.jpg",
      "/images/casa-brisa/02.jpg",
      "/images/casa-brisa/03.jpg",
      "/images/casa-brisa/04.jpg",
      "/images/casa-brisa/05.jpg",
      "/images/casa-brisa/06.jpg",
    ],
    mapEmbed:
      "https://www.google.com/maps?q=Honduras+Shores+Plantation+San+Juan+Tela+Atl%C3%A1ntida+Honduras&output=embed",
    gemelas: true,
    pricePerNightUSD: 90,
    cleaningFeeUSD: 14,
    pricePerNightHNL: 2500,
    cleaningFeeHNL: 350,
  },

  // ──────────────────────────────────────────────────────────
  // 3. CASA MAREA — LAS GEMELAS DE TELA
  // ──────────────────────────────────────────────────────────
  {
    slug: "casa-marea",
    name: "Casa Marea",
    type: "Casa residencial",
    location: "Honduras Shores Plantation, San Juan, Tela, Atlántida",
    city: "Tela",
    capacity: 6,
    bedrooms: [
      { name: "Habitación principal", beds: "1 cama Queen" },
      { name: "Habitación secundaria", beds: "1 litera + 1 cama individual" },
    ],
    bathrooms: 2,
    amenities: [
      "Cocina completamente equipada",
      "Aire acondicionado en todas las habitaciones y sala",
      "Asador de carbón en jardín",
      "WiFi dual (2 redes)",
      "Estacionamiento amplio",
      "Generador eléctrico",
    ],
    highlights: [
      "Ubicada en Honduras Shores Plantation",
      "Playa a pasos — Tela, Atlántida",
      "Generador eléctrico incluido",
      "Se puede rentar junto a Casa Brisa para 12 personas",
    ],
    description: [
      "Casa Marea es tu escapada perfecta al Caribe hondureño. Ubicada en Honduras Shores Plantation en Tela, a metros de la playa, tiene todo lo que necesitas para desconectarte por completo.",
      "Despertás, preparás el desayuno en la cocina equipada, y en minutos ya estás en la playa. Por las tardes, el jardín con asador te espera para terminar el día como debe ser.",
      "Casa Marea es parte de Las Gemelas de Tela junto a Casa Brisa. Si son más de 6, pueden rentar ambas casas para hasta 12 personas en la misma propiedad sin sacrificar privacidad ni comodidad.",
    ],
    images: [
      "/images/casa-marea/11.jpg",
      "/images/casa-marea/12.jpg",
      "/images/casa-marea/10.jpg",
      "/images/casa-marea/02.jpg",
      "/images/casa-marea/03.jpg",
      "/images/casa-marea/04.jpg",
      "/images/casa-marea/05.jpg",
      "/images/casa-marea/06.jpg",
      "/images/casa-marea/07.jpg",
      "/images/casa-marea/08.jpg",
    ],
    mapEmbed:
      "https://www.google.com/maps?q=Honduras+Shores+Plantation+San+Juan+Tela+Atl%C3%A1ntida+Honduras&output=embed",
    gemelas: true,
    pricePerNightUSD: 90,
    cleaningFeeUSD: 14,
    pricePerNightHNL: 2500,
    cleaningFeeHNL: 350,
  },

  // ──────────────────────────────────────────────────────────
  // 4. CENTRO MORAZÁN
  // ──────────────────────────────────────────────────────────
  {
    slug: "centro-morazan",
    name: "Centro Morazán",
    type: "Apartamento",
    location: "Torre 1, Piso 20, Apto. 1-2004 — Tegucigalpa",
    city: "Tegucigalpa",
    capacity: 6,
    bedrooms: [
      { name: "Habitación principal", beds: "1 cama Queen" },
      { name: "Habitación secundaria", beds: "1 cama Queen + 1 cama adicional" },
    ],
    bathrooms: 2,
    amenities: [
      "WiFi",
      "Aire acondicionado en ambas habitaciones",
      "Estacionamiento incluido (1 carro; carro adicional con costo)",
      "Acceso a amenidades del edificio",
    ],
    highlights: [
      "Piso 20 con vistas panorámicas de Tegucigalpa",
      "Acceso a amenidades del edificio",
      "Estacionamiento incluido",
      "Capacidad para 6 personas",
    ],
    description: [
      "Centro Morazán es un apartamento de lujo en el piso 20 de Torre 1 en el corazón de Tegucigalpa, con vistas panorámicas de la capital hondureña.",
      "Ideal para viajes de negocios o turismo, combina la comodidad de un hogar con el acceso a todas las amenidades del edificio y una ubicación céntrica inmejorable.",
      "Ambas habitaciones cuentan con cama Queen y aire acondicionado propio, y el apartamento incluye estacionamiento para un vehículo.",
    ],
    images: [
      "/images/centro-morazan/01.jpg",
      "/images/centro-morazan/02.jpg",
      "/images/centro-morazan/03.jpg",
      "/images/centro-morazan/04.jpg",
      "/images/centro-morazan/05.jpg",
    ],
    mapEmbed:
      "https://www.google.com/maps?q=Centro+Morazan+Tegucigalpa&output=embed",
    pricePerNightUSD: 80,
    cleaningFeeUSD: 16,
    pricePerNightHNL: 2100,
    cleaningFeeHNL: 400,
  },

  // ──────────────────────────────────────────────────────────
  // 5. CASA LARA TOWNHOUSE
  // ──────────────────────────────────────────────────────────
  {
    slug: "casa-lara-townhouse",
    name: "Casa Lara Townhouse",
    type: "Townhouse",
    location: "Colonia Lara, Tegucigalpa (junto a Torre Lara / Plaza Lara)",
    city: "Tegucigalpa",
    capacity: 4,
    bedrooms: [
      { name: "Habitación principal", beds: "1 cama Queen (baño privado)" },
      { name: "Habitación secundaria", beds: "1 cama Queen (baño privado)" },
    ],
    bathrooms: 3,
    amenities: [
      "WiFi",
      "Aire acondicionado en ambas habitaciones",
      "Estacionamiento para 1 carro",
      "Control de portón inteligente (desde comedor)",
      "Baño privado en cada habitación",
    ],
    highlights: [
      "Ambas habitaciones con baño privado",
      "Zona exclusiva de Colonia Lara",
      "Cerca de Plaza Lara y Torre Lara",
      "Capacidad para 4 personas",
    ],
    description: [
      "Casa Lara Townhouse es un moderno townhouse en Colonia Lara, una de las zonas más exclusivas de Tegucigalpa, a pasos de Torre Lara y Plaza Lara.",
      "Ambas habitaciones cuentan con cama Queen y baño privado — sin compartir, sin compromiso de privacidad. Ideal para dos parejas o viajeros de negocios que buscan comodidad y ubicación.",
      "Con acceso a restaurantes, centros comerciales y oficinas en minutos, y el portón controlado inteligentemente desde el comedor, Casa Lara Townhouse es la opción más práctica de la capital.",
    ],
    images: [
      "/images/casa-lara-townhouse/01.jpg",
      "/images/casa-lara-townhouse/02.jpg",
      "/images/casa-lara-townhouse/03.jpg",
      "/images/casa-lara-townhouse/04.jpg",
      "/images/casa-lara-townhouse/05.jpg",
    ],
    mapEmbed:
      "https://www.google.com/maps?q=Colonia+Lara+Tegucigalpa&output=embed",
    pricePerNightUSD: 60,
    cleaningFeeUSD: 16,
    pricePerNightHNL: 1590,
    cleaningFeeHNL: 400,
  },

  // ──────────────────────────────────────────────────────────
  // 6. LA FLORIDA
  // ──────────────────────────────────────────────────────────
  {
    slug: "la-florida",
    name: "La Florida",
    type: "Apartamento",
    location: "Residencial Lomas de la Florida, Tegucigalpa",
    city: "Tegucigalpa",
    capacity: 3,
    bedrooms: [
      { name: "Habitación principal", beds: "1 cama (doble o matrimonial)" },
      { name: "Sala", beds: "Sofá cama para 1 persona" },
    ],
    bathrooms: 1,
    amenities: [
      "Cocina completamente equipada",
      "Sala",
      "Lavadora y secadora",
      "Aire acondicionado",
      "WiFi",
      "Seguridad residencial 24/7",
    ],
    highlights: [
      "Lavadora y secadora incluidas",
      "Seguridad 24/7 en residencial privada",
      "Cocina completamente equipada",
      "Ideal para estadías largas o viajes de trabajo",
    ],
    description: [
      "La Florida es un acogedor apartamento en Residencial Lomas de la Florida, Tegucigalpa — ideal para quienes buscan un espacio cómodo, funcional y seguro para estadías individuales o en pareja.",
      "Cuenta con cocina completamente equipada, sala con sofá cama, lavadora y secadora propias — una comodidad que marca la diferencia en estadías largas — y aire acondicionado para el descanso total.",
      "Ubicado en una residencial privada con seguridad 24/7, La Florida combina tranquilidad y practicidad en una de las zonas residenciales más agradables de la capital.",
    ],
    images: [
      "/images/la-florida/03.jpg",
      "/images/la-florida/05.jpg",
      "/images/la-florida/02.jpg",
      "/images/la-florida/04.jpg",
      "/images/la-florida/06.jpg",
      "/images/la-florida/01.jpg",
    ],
    mapEmbed:
      "https://www.google.com/maps?q=Lomas+de+la+Florida+Tegucigalpa&output=embed",
    pricePerNightUSD: 26,
    cleaningFeeUSD: 14,
    pricePerNightHNL: 650,
    cleaningFeeHNL: 350,
  },
];

export function getProperty(slug: string): Property | undefined {
  return properties.find((p) => p.slug === slug);
}

export function getRelatedProperties(slug: string, limit = 3): Property[] {
  const current = getProperty(slug);
  if (!current) return properties.slice(0, limit);
  return properties
    .filter((p) => p.slug !== slug)
    .sort((a, b) => {
      const aSame = a.city === current.city ? 0 : 1;
      const bSame = b.city === current.city ? 0 : 1;
      return aSame - bSame;
    })
    .slice(0, limit);
}
