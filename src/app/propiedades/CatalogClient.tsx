"use client";

import { useState } from "react";
import PropertyCard from "@/components/PropertyCard";
import { properties, CITIES } from "@/data/properties";

const FILTERS = ["Todas", ...CITIES] as const;
type Filter = (typeof FILTERS)[number];

export default function CatalogClient() {
  const [filter, setFilter] = useState<Filter>("Todas");

  const list =
    filter === "Todas"
      ? properties
      : properties.filter((p) => p.city === filter);

  const countFor = (f: Filter) =>
    f === "Todas" ? properties.length : properties.filter((p) => p.city === f).length;

  return (
    <>
      {/* Filtros por ciudad */}
      <div className="flex flex-wrap gap-2 justify-center mb-10">
        {FILTERS.map((f) => {
          const active = f === filter;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={active}
              className={
                "px-5 py-2 rounded-full text-sm font-medium transition-colors " +
                (active
                  ? "bg-primary text-white"
                  : "bg-white text-primary border border-gray-200 hover:border-secondary")
              }
            >
              {f}
              <span className={"ml-1.5 " + (active ? "text-white/70" : "text-muted")}>
                {countFor(f)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Grid de propiedades */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {list.map((p, i) => (
          <PropertyCard key={p.slug} property={p} priority={i < 3} />
        ))}
      </div>

      {/* Nota de Las Gemelas (cuando aplica) */}
      {(filter === "Todas" || filter === "Tela") && (
        <p className="text-center text-sm text-muted mt-8">
          🏠🏠 En Tela, Casa Brisa y Casa Marea se pueden rentar juntas — Las
          Gemelas — para grupos de hasta 12 personas.
        </p>
      )}
    </>
  );
}
