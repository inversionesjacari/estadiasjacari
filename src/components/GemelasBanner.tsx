import Image from "next/image";
import Link from "next/link";

export default function GemelasBanner() {
  const whatsapp =
    "https://wa.me/50488390145?text=" +
    encodeURIComponent(
      "Hola, me interesa rentar Las Gemelas de Tela (Casa Brisa + Casa Marea) para mi grupo."
    );

  return (
    <section className="py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-3xl bg-secondary/10 border border-secondary/40">
          <div
            aria-hidden
            className="absolute inset-0 opacity-10"
            style={{
              backgroundImage: "url(/branding/pattern-teal.png)",
              backgroundSize: "240px",
              backgroundRepeat: "repeat",
            }}
          />
          <div className="relative grid md:grid-cols-2 gap-8 p-8 md:p-12 items-center">
            <div>
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-secondary mb-3">
                <span className="text-2xl">🏠🏠</span> Especial para grupos
              </p>
              <h3 className="font-display text-3xl lg:text-4xl text-primary mb-4">
                Las Gemelas de Tela
              </h3>
              <p className="text-gray-700 mb-2 font-medium">
                Dos casas · una propiedad · hasta 12 personas
              </p>
              <p className="text-gray-600 mb-6 leading-relaxed">
                Casa Marea y Casa Brisa están en la misma propiedad en Honduras
                Shores Plantation. Rentalas juntas o por separado según tu
                grupo, sin sacrificar privacidad ni comodidad.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/propiedades/casa-marea" className="btn-primary">
                  Ver Casa Marea
                </Link>
                <Link href="/propiedades/casa-brisa" className="btn-outline">
                  Ver Casa Brisa
                </Link>
                <a
                  href={whatsapp}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-accent"
                >
                  Rentar ambas →
                </a>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:gap-4">
              <div className="aspect-[4/5] relative rounded-2xl overflow-hidden">
                <Image
                  src="/images/casa-marea/01.jpg"
                  alt="Casa Marea"
                  fill
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  className="object-cover"
                />
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                  <p className="text-white font-display text-lg">Casa Marea</p>
                </div>
              </div>
              <div className="aspect-[4/5] relative rounded-2xl overflow-hidden mt-8">
                <Image
                  src="/images/casa-brisa/01.png"
                  alt="Casa Brisa"
                  fill
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  className="object-cover"
                />
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                  <p className="text-white font-display text-lg">Casa Brisa</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
