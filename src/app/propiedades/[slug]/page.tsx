import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import {
  properties,
  getProperty,
  getRelatedProperties,
} from "@/data/properties";
import Gallery from "@/components/Gallery";
import BookingWidget from "@/components/BookingWidget";
import PropertyCard from "@/components/PropertyCard";
import HostCard from "@/components/HostCard";
import ReviewsSection from "@/components/ReviewsSection";
import JsonLd from "@/components/JsonLd";
import { vacationRentalSchema, breadcrumbSchema } from "@/lib/schema";
import { aggregateFor } from "@/data/reviews";
import { SITE_NAME } from "@/lib/site";
import { waUrl, waMessage } from "@/lib/whatsapp";

export function generateStaticParams() {
  return properties.map((p) => ({ slug: p.slug }));
}

export function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Metadata {
  const p = getProperty(params.slug);
  if (!p) return { title: "Propiedad no encontrada" };
  const title = `${p.name} — Estadías Jacarí`;
  const description = p.description[0];
  const url = `/propiedades/${p.slug}`;
  const ogImage = `/og/${p.slug}.jpg`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title,
      description,
      url,
      locale: "es_HN",
      images: [{ url: ogImage, width: 1200, height: 630, alt: p.name }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}

export default function PropertyDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const property = getProperty(params.slug);
  if (!property) notFound();

  const related = getRelatedProperties(property.slug, 3);

  return (
    <article className="pt-24 lg:pt-28 pb-24 lg:pb-0">
      <JsonLd
        data={vacationRentalSchema(property, aggregateFor(property.slug))}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Inicio", url: "/" },
          { name: "Propiedades", url: "/propiedades" },
          { name: property.name, url: `/propiedades/${property.slug}` },
        ])}
      />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Crumbs */}
        <nav className="text-sm text-muted mb-6">
          <Link href="/" className="hover:text-primary">
            Inicio
          </Link>
          <span className="mx-2">/</span>
          <Link href="/propiedades" className="hover:text-primary">
            Propiedades
          </Link>
          <span className="mx-2">/</span>
          <span className="text-primary">{property.name}</span>
        </nav>

        {/* Header */}
        <header className="mb-6 lg:mb-8 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs uppercase tracking-wider text-secondary bg-secondary/10 px-3 py-1 rounded-full">
                {property.type}
              </span>
              {property.gemelas && (
                <span className="text-xs uppercase tracking-wider text-accent bg-accent/10 px-3 py-1 rounded-full">
                  Las Gemelas
                </span>
              )}
            </div>
            <h1 className="font-display text-4xl lg:text-5xl text-primary mb-2">
              {property.name}
            </h1>
            <p className="text-muted inline-flex items-center gap-1.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 22s8-7.58 8-13a8 8 0 1 0-16 0c0 5.42 8 13 8 13Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              {property.location}
            </p>
          </div>
        </header>

        {/* Gallery */}
        <Gallery images={property.images} alt={property.name} />

        {/* Body: 2 columns */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-10 lg:gap-12 mt-10 lg:mt-14">
          <div className="lg:col-span-2 space-y-12">
            {/* Quick stats */}
            <section className="grid grid-cols-3 gap-4 border-y border-gray-100 py-6">
              <Stat label="Huéspedes" value={property.capacity} />
              <Stat label="Habitaciones" value={property.bedrooms.length} />
              <Stat label="Baños" value={property.bathrooms} />
            </section>

            {/* Description */}
            <section>
              <h2 className="font-display text-2xl text-primary mb-4">
                Sobre esta propiedad
              </h2>
              <div className="space-y-4 text-gray-700 leading-relaxed">
                {property.description.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </section>

            <HostCard propertyName={property.name} />

            {/* Bedrooms */}
            <section>
              <h2 className="font-display text-2xl text-primary mb-4">
                Distribución
              </h2>
              <div className="grid sm:grid-cols-2 gap-4">
                {property.bedrooms.map((b) => (
                  <div
                    key={b.name}
                    className="bg-white border border-gray-100 rounded-xl p-5"
                  >
                    <p className="text-xs uppercase tracking-wider text-secondary mb-1">
                      Habitación
                    </p>
                    <h3 className="font-display text-lg text-primary mb-1">
                      {b.name}
                    </h3>
                    <p className="text-sm text-muted">{b.beds}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Amenities */}
            <section>
              <h2 className="font-display text-2xl text-primary mb-4">
                Amenidades
              </h2>
              <div className="flex flex-wrap gap-2">
                {property.amenities.map((a) => (
                  <span key={a} className="chip">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M5 12l5 5L20 7"
                        stroke="#289DAE"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {a}
                  </span>
                ))}
              </div>
            </section>

            {/* Gemelas callout */}
            {property.gemelas && (
              <section className="bg-secondary/10 border border-secondary/40 rounded-2xl p-6 md:p-8">
                <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-secondary mb-3">
                  <span className="text-xl">🏠🏠</span>
                  ¿Son más de 6?
                </p>
                <h3 className="font-display text-2xl text-primary mb-2">
                  Las Gemelas de Tela
                </h3>
                <p className="text-gray-700 mb-1 font-medium">
                  Dos casas · una propiedad · hasta 12 personas
                </p>
                <p className="text-gray-600 mb-5 leading-relaxed">
                  Casa Marea y Casa Brisa están en la misma propiedad en
                  Honduras Shores Plantation. Pueden rentarse juntas o por
                  separado según el tamaño del grupo.
                </p>
                <a
                  href={waUrl(waMessage.gemelas())}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-accent"
                >
                  Ver opción para grupos →
                </a>
              </section>
            )}

            {/* Highlights */}
            <section>
              <h2 className="font-display text-2xl text-primary mb-4">
                Lo destacado
              </h2>
              <ul className="space-y-2">
                {property.highlights.map((h) => (
                  <li
                    key={h}
                    className="flex items-start gap-3 text-gray-700"
                  >
                    <span className="mt-1 text-accent">★</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </section>

            <ReviewsSection slug={property.slug} />

            {/* Map */}
            <section>
              <h2 className="font-display text-2xl text-primary mb-4">
                Ubicación
              </h2>
              <div className="rounded-2xl overflow-hidden border border-gray-100">
                <iframe
                  src={property.mapEmbed}
                  width="100%"
                  height="380"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  className="w-full"
                  title={`Mapa de ${property.name}`}
                />
              </div>
              <p className="text-xs text-muted mt-2">
                Ubicación aproximada. La dirección exacta se comparte al
                confirmar la reserva.
              </p>
            </section>
          </div>

          {/* Sidebar */}
          <aside id="reservar" className="lg:col-span-1 scroll-mt-24">
            <BookingWidget
              propertyName={property.name}
              propertySlug={property.slug}
              pricePerNightUSD={property.pricePerNightUSD}
              cleaningFeeUSD={property.cleaningFeeUSD}
              pricePerNightHNL={property.pricePerNightHNL}
              cleaningFeeHNL={property.cleaningFeeHNL}
            />
            <p className="text-xs text-muted text-center mt-3">
              Cancelación flexible: reembolso completo hasta 7 días antes.{" "}
              <Link href="/politicas" className="underline hover:text-primary">
                Ver políticas
              </Link>
            </p>
          </aside>
        </div>

        {/* Related */}
        <section className="mt-20 lg:mt-24 border-t border-gray-100 pt-14">
          <h2 className="font-display text-3xl text-primary mb-8 text-center">
            Otras propiedades
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {related.map((p) => (
              <PropertyCard key={p.slug} property={p} />
            ))}
          </div>
        </section>
      </div>

      {/* Barra fija de reserva — solo mobile (el widget queda abajo en celular).
          pr-20 deja libre la esquina inferior derecha para el botón flotante de
          WhatsApp (56px + 24px de margen) y que no se encimen. */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t border-gray-200 pl-4 pr-20 py-3 flex items-center justify-between gap-3">
        <div className="leading-tight">
          <p className="text-xs text-muted">Desde</p>
          <p className="font-display text-lg text-primary">
            HNL {property.pricePerNightHNL.toLocaleString("es-HN")}
            <span className="text-sm text-muted"> /noche</span>
          </p>
        </div>
        <a href="#reservar" className="btn-accent whitespace-nowrap">
          Reservar →
        </a>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <p className="font-display text-3xl text-primary">{value}</p>
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
    </div>
  );
}
