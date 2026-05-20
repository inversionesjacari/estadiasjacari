import Image from "next/image";
import HeroSearch from "@/components/HeroSearch";
import PropertyGrid from "@/components/PropertyGrid";
import WhyUs from "@/components/WhyUs";
import ContactCTA from "@/components/ContactCTA";

export default function HomePage() {
  return (
    <>
      <section className="relative min-h-[88vh] flex items-center justify-center text-white overflow-hidden">
        <Image
          src="/images/casa-marea/12.jpg"
          alt="Playa del Caribe hondureño"
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-primary/40 via-primary/30 to-primary/70" />

        <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 text-center pt-16">
          <p className="inline-block text-[11px] uppercase tracking-[0.25em] text-accent bg-white/10 border border-white/20 backdrop-blur-sm px-4 py-1.5 rounded-full mb-6">
            Alquileres Temporales en Honduras
          </p>
          <h1 className="font-display text-4xl sm:text-5xl lg:text-7xl leading-tight text-white mb-5">
            Tu próxima estadía en Honduras, perfecta.
          </h1>
          <p className="text-white/85 text-lg sm:text-xl max-w-2xl mx-auto mb-10 leading-relaxed">
            Alquileres temporales con todo lo que necesitas para sentirte en
            casa, desde la playa del Caribe hasta el corazón de Tegucigalpa.
          </p>
          <div className="flex justify-center">
            <HeroSearch />
          </div>
        </div>
      </section>

      <PropertyGrid />

      <WhyUs />

      <ContactCTA />
    </>
  );
}
