// Reseñas reales extraídas de los listings de Airbnb de Estadías Jacarí
// (verificado: anfitrión "Inmobiliaria Jacarí" / coanfitriones Eduardo y
// César en los 5). Copiadas a mano el 2026-07-07 — Airbnb bloquea el
// scraping automatizado, así que esto NO se puede regenerar con un script.
// Si querés actualizar el contenido, hay que volver a revisar cada listing.
//
// Rating agregado real por propiedad (para JSON-LD aggregateRating):
//   villa-b11-palma-real   4.5  / 20 reviews
//   casa-brisa             4.24 / 17 reviews
//   casa-marea             4.68 / 66 reviews
//   centro-morazan         4.87 / 130 reviews ("Favorito entre huéspedes")
//   casa-lara-townhouse    4.7  / 37 reviews
//   la-florida             sin listing propio en Airbnb todavía — sin reviews
export interface Review {
  propertySlug: string;
  author: string;
  date: string; // "AAAA-MM"
  text: string;
  rating: number;
  source: "airbnb";
}

export const AGGREGATE_RATINGS: Record<
  string,
  { ratingValue: number; reviewCount: number }
> = {
  "villa-b11-palma-real": { ratingValue: 4.5, reviewCount: 20 },
  "casa-brisa": { ratingValue: 4.24, reviewCount: 17 },
  "casa-marea": { ratingValue: 4.68, reviewCount: 66 },
  "centro-morazan": { ratingValue: 4.87, reviewCount: 130 },
  "casa-lara-townhouse": { ratingValue: 4.7, reviewCount: 37 },
};

export const reviews: Review[] = [
  // Villa B11 — Palma Real
  {
    propertySlug: "villa-b11-palma-real",
    author: "Tesla",
    date: "2026-03",
    text: "Recomiendo esta villa, nos encantó. Dios les bendiga.",
    rating: 4,
    source: "airbnb",
  },
  {
    propertySlug: "villa-b11-palma-real",
    author: "Gladys",
    date: "2026-04",
    text: "Una villa agradable, muy ordenado todo, cerca del hotel.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "villa-b11-palma-real",
    author: "Majo",
    date: "2026-04",
    text: "Excelente lugar",
    rating: 5,
    source: "airbnb",
  },

  // Casa Brisa
  {
    propertySlug: "casa-brisa",
    author: "Javier",
    date: "2026-06",
    text: "Excelente lugar, la zona y el ambiente calmado, muy agradable, limpio el lugar, lo necesario para una estadía, atención rápida y muy disponible, recomendado.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "casa-brisa",
    author: "Alejandra",
    date: "2026-06",
    text: "Buen alojamiento, bastante cómodo y tranquilo para estar con la familia.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "casa-brisa",
    author: "Sara",
    date: "2026-06",
    text: "A mi familia y a mí nos encantó, muy limpio y silencioso para descansar de la ciudad. El hotel es una belleza, venimos encantados con todo, la atención 10 de 10, se los recomiendo.",
    rating: 5,
    source: "airbnb",
  },

  // Casa Marea
  {
    propertySlug: "casa-marea",
    author: "Alex",
    date: "2026-05",
    text: "Si fuera posible, le daría 10 estrellas a César, una calidad de persona y un servicio impecable. Muy agradecido por sus atenciones.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "casa-marea",
    author: "Fabiola",
    date: "2026-01",
    text: "Excelente, lo recomiendo. Es un lugar muy tranquilo para pasar con la familia, muy limpio. Recomendado.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "casa-marea",
    author: "Juan Angel",
    date: "2026-06",
    text: "Todo bien, como se describe.",
    rating: 5,
    source: "airbnb",
  },

  // Centro Morazán
  {
    propertySlug: "centro-morazan",
    author: "Mardonio E.",
    date: "2026-06",
    text: "Lugar ideal, el anfitrión muy atento y el alojamiento cumplía con todo lo que ofrecía… sin duda vale la pena.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "centro-morazan",
    author: "MaFer",
    date: "2026-05",
    text: "Me hospedé en este Airbnb y la experiencia fue excelente. La ubicación es muy conveniente, especialmente si necesitas estar cerca de la embajada americana, ya que queda a pocos minutos y en una zona tranquila y segura.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "centro-morazan",
    author: "Tito Pastor",
    date: "2026-05",
    text: "Fue una estadía agradable. Excelente ubicación y zona tranquila. Rodeada de negocios.",
    rating: 5,
    source: "airbnb",
  },

  // Casa Lara Townhouse
  {
    propertySlug: "casa-lara-townhouse",
    author: "Martín Rodríguez",
    date: "2026-03",
    text: "Muy lindo todo, accesible para citas en la embajada, súper recomendable.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "casa-lara-townhouse",
    author: "Alexandra",
    date: "2026-02",
    text: "Excelente opción si tienes tu cita de embajada, súper cerca, te puedes ir caminando. Calidad/precio excelente, les recomiendo al 100% esta estadía.",
    rating: 5,
    source: "airbnb",
  },
  {
    propertySlug: "casa-lara-townhouse",
    author: "Keily",
    date: "2026-03",
    text: "Muy bonito lugar y cómodo, nos brindaron instrucciones bien claras. Está ubicada en una zona muy favorable, cerca de plazas y la embajada.",
    rating: 5,
    source: "airbnb",
  },
];

export function reviewsFor(slug: string): Review[] {
  return reviews.filter((r) => r.propertySlug === slug);
}

export function aggregateFor(
  slug: string,
): { ratingValue: number; reviewCount: number } | null {
  return AGGREGATE_RATINGS[slug] ?? null;
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function formatReviewDate(date: string): string {
  const [year, month] = date.split("-");
  const idx = parseInt(month, 10) - 1;
  return `${MONTHS[idx] ?? month} de ${year}`;
}
