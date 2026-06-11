import type { Metadata } from "next";
import CatalogClient from "./CatalogClient";

export const metadata: Metadata = {
  title: "Propiedades — Estadías Jacarí",
  description:
    "Nuestras 6 estadías de alquiler vacacional en La Ceiba, Tela y Tegucigalpa. Mirá fotos, capacidad y precios, y reservá en minutos.",
  alternates: { canonical: "/propiedades" },
  openGraph: {
    title: "Propiedades — Estadías Jacarí",
    description:
      "Seis estadías en La Ceiba, Tela y Tegucigalpa. Elegí la tuya, mirá las fotos y reservá.",
    url: "/propiedades",
    type: "website",
  },
};

export default function PropiedadesPage() {
  return (
    <main className="pt-24 lg:pt-28 pb-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Hero */}
        <header className="text-center max-w-2xl mx-auto mb-10 lg:mb-12">
          <p className="text-xs uppercase tracking-[0.2em] text-secondary mb-3">
            Nuestro catálogo
          </p>
          <h1 className="font-display text-4xl lg:text-5xl text-primary mb-4">
            Propiedades
          </h1>
          <p className="text-muted leading-relaxed">
            Seis estadías en La Ceiba, Tela y Tegucigalpa. Elegí la tuya, mirá las
            fotos y reservá en minutos.
          </p>
        </header>

        {/* Filtros + grid (interactivo) */}
        <CatalogClient />

        {/* CTA final */}
        <div className="text-center mt-16">
          <p className="text-gray-700 mb-4">
            ¿No sabés cuál elegir? Te ayudamos a encontrar la ideal.
          </p>
          <a
            href={
              "https://wa.me/50488390145?text=" +
              encodeURIComponent("Hola, quiero ayuda para elegir una propiedad.")
            }
            target="_blank"
            rel="noopener noreferrer"
            className="btn-accent"
          >
            Escribinos por WhatsApp →
          </a>
        </div>
      </div>
    </main>
  );
}
