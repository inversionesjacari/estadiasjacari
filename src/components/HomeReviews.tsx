import { reviews, formatReviewDate } from "@/data/reviews";
import { getProperty } from "@/data/properties";
import Stars from "@/components/Stars";

// Selección cross-propiedad de las mejores reseñas para el home. Scroll
// horizontal con CSS puro (scroll-snap) — sin JS, funciona como server
// component.
const FEATURED = [
  { propertySlug: "casa-marea", author: "Alex" },
  { propertySlug: "centro-morazan", author: "Mardonio E." },
  { propertySlug: "casa-brisa", author: "Javier" },
  { propertySlug: "casa-lara-townhouse", author: "Alexandra" },
];

export default function HomeReviews() {
  const featured = FEATURED.map(({ propertySlug, author }) =>
    reviews.find((r) => r.propertySlug === propertySlug && r.author === author),
  ).filter((r): r is NonNullable<typeof r> => Boolean(r));

  if (featured.length === 0) return null;

  return (
    <section className="py-16 lg:py-20 bg-bg">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <p className="text-xs uppercase tracking-[0.2em] text-secondary mb-3">
            Huéspedes reales
          </p>
          <h2 className="font-display text-3xl lg:text-4xl text-primary">
            Lo que dicen de nosotros
          </h2>
        </div>
        <div className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-4 -mx-4 px-4 sm:mx-0 sm:px-0">
          {featured.map((r) => {
            const property = getProperty(r.propertySlug);
            return (
              <div
                key={`${r.propertySlug}-${r.author}`}
                className="snap-start flex-shrink-0 w-[280px] sm:w-[320px] bg-white border border-gray-100 rounded-2xl p-5"
              >
                <Stars rating={r.rating} />
                <p className="text-gray-700 leading-relaxed mt-2 mb-3 text-sm">
                  &ldquo;{r.text}&rdquo;
                </p>
                <p className="text-xs text-muted">
                  {r.author} · {property?.name} · {formatReviewDate(r.date)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
