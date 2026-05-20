import Image from "next/image";
import Link from "next/link";
import type { Property } from "@/data/properties";

interface Props {
  property: Property;
  priority?: boolean;
}

export default function PropertyCard({ property, priority = false }: Props) {
  const main = property.images[0];
  return (
    <Link
      href={`/propiedades/${property.slug}`}
      className="group flex flex-col bg-white rounded-2xl overflow-hidden border border-transparent hover:border-secondary hover:shadow-card transition-all duration-300"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-gray-100">
        <Image
          src={main}
          alt={property.name}
          fill
          sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          priority={priority}
        />
        <span className="absolute top-3 left-3 bg-secondary text-white text-xs font-medium px-3 py-1 rounded-full">
          {property.city}
        </span>
        {property.gemelas && (
          <span className="absolute top-3 right-3 bg-accent text-white text-xs font-medium px-3 py-1 rounded-full">
            Las Gemelas
          </span>
        )}
      </div>

      <div className="p-5 flex flex-col flex-1">
        <p className="text-xs uppercase tracking-wider text-muted mb-1">
          {property.type}
        </p>
        <h3 className="font-display text-xl text-primary mb-1 leading-tight">
          {property.name}
        </h3>
        <p className="text-sm text-muted mb-4 line-clamp-1">
          {property.location}
        </p>

        <div className="flex items-center gap-4 text-sm text-gray-700 mt-auto pt-3 border-t border-gray-100">
          <Spec icon="people" value={`${property.capacity}`} label="huéspedes" />
          <Spec
            icon="bed"
            value={`${property.bedrooms.length}`}
            label={property.bedrooms.length === 1 ? "habitación" : "habitaciones"}
          />
          <Spec
            icon="bath"
            value={`${property.bathrooms}`}
            label={property.bathrooms === 1 ? "baño" : "baños"}
          />
        </div>

        <div className="mt-4">
          <span className="text-accent font-medium text-sm group-hover:underline">
            Ver detalles →
          </span>
        </div>
      </div>
    </Link>
  );
}

function Spec({
  icon,
  value,
  label,
}: {
  icon: "people" | "bed" | "bath";
  value: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon kind={icon} />
      <span className="font-medium">{value}</span>
      <span className="text-muted hidden sm:inline">{label}</span>
    </span>
  );
}

function Icon({ kind }: { kind: "people" | "bed" | "bath" }) {
  const stroke = "currentColor";
  if (kind === "people") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm6 9a8 8 0 1 0-16 0"
          stroke={stroke}
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === "bed") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M3 18V8m18 10v-5a3 3 0 0 0-3-3H3m18 8H3m6-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
          stroke={stroke}
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3Zm2 0V6a2 2 0 0 1 2-2h2v3M6 20l-1 2m14-2 1 2"
        stroke={stroke}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
