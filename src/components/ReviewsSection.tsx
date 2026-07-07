import { reviewsFor, aggregateFor, formatReviewDate } from "@/data/reviews";
import Stars from "@/components/Stars";

export default function ReviewsSection({ slug }: { slug: string }) {
  const propertyReviews = reviewsFor(slug);
  if (propertyReviews.length === 0) return null;

  const agg = aggregateFor(slug);

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="font-display text-2xl text-primary">
          Lo que dicen nuestros huéspedes
        </h2>
        {agg && (
          <span className="text-sm text-muted whitespace-nowrap">
            {agg.ratingValue.toFixed(2)} ★ · {agg.reviewCount} reseñas en Airbnb
          </span>
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        {propertyReviews.map((r) => (
          <div
            key={`${r.author}-${r.date}`}
            className="bg-white border border-gray-100 rounded-2xl p-5"
          >
            <Stars rating={r.rating} />
            <p className="text-gray-700 leading-relaxed mt-2 mb-3">
              &ldquo;{r.text}&rdquo;
            </p>
            <p className="text-xs text-muted">
              {r.author} · Reseña de Airbnb · {formatReviewDate(r.date)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
