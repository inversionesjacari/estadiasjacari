import Image from "next/image";
import Link from "next/link";

export default function Footer() {
  return (
    <footer className="relative mt-20 overflow-hidden bg-primary text-white">
      {/* Gradient softener so the bottom feels deeper */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-white/0 via-transparent to-black/30"
      />

      {/* Decorative arc — placed once, never tiled, fading out */}
      <svg
        aria-hidden
        viewBox="0 0 600 600"
        className="absolute -right-32 -bottom-32 w-[36rem] h-[36rem] text-white/[0.06] pointer-events-none"
      >
        <g fill="none" stroke="currentColor" strokeWidth="6">
          <path d="M50 550 V 250 a 250 250 0 0 1 500 0 V 550" />
          <path d="M150 550 V 280 a 150 150 0 0 1 300 0 V 550" />
          <circle cx="300" cy="380" r="120" />
        </g>
      </svg>

      {/* Top accent line */}
      <div
        aria-hidden
        className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-1 bg-accent rounded-full"
      />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 lg:py-12">
        {/* Brand row: logo+name left · social icons right */}
        <div className="flex items-center justify-between gap-4">
          <Link
            href="/"
            className="flex items-center gap-3 group"
            aria-label="Estadías Jacarí — Inicio"
          >
            <Image
              src="/logo-white.svg"
              alt=""
              width={52}
              height={52}
              className="block flex-shrink-0"
            />
            <span className="font-display text-2xl lg:text-3xl leading-none">
              Estadías Jacarí
            </span>
          </Link>

          {/* Social icons */}
          <div className="flex items-center gap-5">
            <a
              href="https://www.facebook.com/profile.php?id=100078132980551"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Facebook de Estadías Jacarí"
              className="text-white/70 hover:text-accent transition"
            >
              <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
              </svg>
            </a>
            <a
              href="https://www.instagram.com/estadiasjacari"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Instagram de Estadías Jacarí"
              className="text-white/70 hover:text-accent transition"
            >
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
              </svg>
            </a>
          </div>
        </div>

        {/* Links */}
        <nav className="mt-6 pt-5 border-t border-white/15 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-white/70">
          <Link href="/propiedades" className="hover:text-accent transition">
            Propiedades
          </Link>
          <Link href="/politicas" className="hover:text-accent transition">
            Políticas
          </Link>
          <Link href="/preguntas-frecuentes" className="hover:text-accent transition">
            Preguntas frecuentes
          </Link>
        </nav>

        {/* Divider + copyright */}
        <div className="mt-6 pt-5 border-t border-white/15">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-2 text-xs text-white/45">
            <p>
              © {new Date().getFullYear()} Estadías Jacarí. Todos los derechos
              reservados.
            </p>
            <p>Hecho con cariño en Honduras 🇭🇳</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
