export default function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-accent text-sm" aria-label={`${rating} de 5 estrellas`}>
      {"★".repeat(rating)}
      <span className="text-gray-300">{"★".repeat(5 - rating)}</span>
    </span>
  );
}
