"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 inset-x-0 z-40 transition-all duration-300 bg-white ${
        scrolled
          ? "shadow-lg border-b border-gray-100"
          : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex items-center justify-between h-[5.5rem] lg:h-[6.25rem]">
        <Link href="/" className="flex items-center gap-3.5 lg:gap-4 group min-w-0">
          <Image
            src="/logo.jpg"
            alt="Estadías Jacarí"
            width={88}
            height={88}
            className="w-[4.5rem] h-[4.5rem] lg:w-[5.5rem] lg:h-[5.5rem] block transition-transform group-hover:scale-105 flex-shrink-0"
            priority
          />
          <span className="text-primary font-display leading-none text-[1.7rem] sm:text-4xl lg:text-[4rem] whitespace-nowrap">
            Estadías Jacarí
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-3">
          <Link href="/propiedades" className="btn-outline !py-2.5 !px-5 text-sm">
            Propiedades
          </Link>
          <Link href="/#contacto" className="btn-primary !py-2.5 !px-5 text-sm">
            Contacto
          </Link>
          <Link href="/#propiedades" className="btn-accent !py-2.5 !px-5 text-sm">
            Ver disponibilidad
          </Link>
        </nav>

        <button
          aria-label="Abrir menú"
          className="md:hidden text-primary p-2"
          onClick={() => setOpen(!open)}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            {open ? (
              <path
                d="M6 6l12 12M6 18L18 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            )}
          </svg>
        </button>
      </div>

      {open && (
        <div className="md:hidden bg-white border-t border-gray-100">
          <div className="px-4 py-4 flex flex-col gap-3">
            <Link
              href="/propiedades"
              onClick={() => setOpen(false)}
              className="btn-outline w-full text-sm"
            >
              Propiedades
            </Link>
            <Link
              href="/#contacto"
              onClick={() => setOpen(false)}
              className="btn-primary w-full text-sm"
            >
              Contacto
            </Link>
            <Link
              href="/#propiedades"
              onClick={() => setOpen(false)}
              className="btn-accent w-full text-sm"
            >
              Ver disponibilidad
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
