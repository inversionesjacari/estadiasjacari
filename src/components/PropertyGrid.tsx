"use client";

import { useEffect, useState } from "react";
import { properties, CITIES } from "@/data/properties";
import PropertyCard from "./PropertyCard";
import GemelasBanner from "./GemelasBanner";

export default function PropertyGrid() {
  const [city, setCity] = useState<string>("");

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setCity(detail ?? "");
    };
    window.addEventListener("filter-city", handler);
    return () => window.removeEventListener("filter-city", handler);
  }, []);

  const filtered = city
    ? properties.filter((p) => p.city === city)
    : properties;

  return (
    <section id="propiedades" className="py-20 lg:py-24 bg-bg">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10 lg:mb-14">
          <p className="text-xs uppercase tracking-[0.2em] text-secondary mb-3">
            Catálogo
          </p>
          <h2 className="font-display text-4xl lg:text-5xl text-primary mb-4">
            Nuestras Propiedades
          </h2>
          <p className="text-muted max-w-2xl mx-auto">
            Seis propiedades verificadas en La Ceiba, Tela y Tegucigalpa —
            equipadas con todo para que solo decidas qué llevar.
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-2 mb-10">
          <FilterChip active={city === ""} onClick={() => setCity("")}>
            Todas
          </FilterChip>
          {CITIES.map((c) => (
            <FilterChip
              key={c}
              active={city === c}
              onClick={() => setCity(c)}
            >
              {c}
            </FilterChip>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p className="text-center text-muted py-12">
            No hay propiedades en {city} todavía.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
            {filtered.map((p, i) => (
              <PropertyCard
                key={p.slug}
                property={p}
                priority={i < 3}
              />
            ))}
          </div>
        )}
      </div>

      {city === "Tela" && <GemelasBanner />}
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-sm px-4 py-2 rounded-full border transition-all ${
        active
          ? "bg-primary text-white border-primary"
          : "bg-white text-primary border-gray-200 hover:border-secondary"
      }`}
    >
      {children}
    </button>
  );
}
