"use client";

import Image from "next/image";
import { useState, useEffect, useCallback } from "react";

interface Props {
  images: string[];
  alt: string;
}

export default function Gallery({ images, alt }: Props) {
  const [active, setActive] = useState(0);
  const [lightbox, setLightbox] = useState<number | null>(null);

  const close = useCallback(() => setLightbox(null), []);
  const next = useCallback(
    () => setLightbox((i) => (i === null ? null : (i + 1) % images.length)),
    [images.length]
  );
  const prev = useCallback(
    () =>
      setLightbox((i) =>
        i === null ? null : (i - 1 + images.length) % images.length
      ),
    [images.length]
  );

  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [lightbox, close, next, prev]);

  const thumbs = images.slice(1, 5);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3">
        <button
          type="button"
          onClick={() => setLightbox(active)}
          className="relative aspect-[4/3] md:aspect-auto md:row-span-2 md:col-span-2 rounded-2xl overflow-hidden bg-gray-100 group"
        >
          <Image
            src={images[active]}
            alt={alt}
            fill
            priority
            sizes="(min-width: 768px) 66vw, 100vw"
            className="object-cover group-hover:scale-[1.02] transition-transform duration-500"
          />
        </button>

        {thumbs.map((src, i) => (
          <button
            key={src}
            type="button"
            onClick={() => {
              setActive(i + 1);
              setLightbox(i + 1);
            }}
            className="relative aspect-[4/3] rounded-2xl overflow-hidden bg-gray-100 group hidden md:block"
          >
            <Image
              src={src}
              alt={`${alt} - foto ${i + 2}`}
              fill
              sizes="33vw"
              className="object-cover group-hover:scale-105 transition-transform duration-500"
            />
            {i === 3 && images.length > 5 && (
              <span className="absolute inset-0 bg-black/55 text-white flex items-center justify-center text-sm font-medium">
                +{images.length - 5} fotos
              </span>
            )}
          </button>
        ))}
      </div>

      {images.length > 1 && (
        <div className="flex md:hidden gap-2 mt-2 overflow-x-auto pb-2">
          {images.map((src, i) => (
            <button
              key={src}
              type="button"
              onClick={() => setActive(i)}
              className={`relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 ${
                active === i ? "border-accent" : "border-transparent"
              }`}
            >
              <Image src={src} alt="" fill sizes="80px" className="object-cover" />
            </button>
          ))}
        </div>
      )}

      {lightbox !== null && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
          onClick={close}
        >
          <button
            aria-label="Cerrar"
            onClick={close}
            className="absolute top-4 right-4 text-white p-3 hover:bg-white/10 rounded-full z-10"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 6l12 12M6 18 18 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            aria-label="Anterior"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            className="absolute left-4 text-white p-3 hover:bg-white/10 rounded-full"
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            aria-label="Siguiente"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            className="absolute right-4 text-white p-3 hover:bg-white/10 rounded-full"
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="relative w-full h-full max-w-6xl max-h-[85vh] mx-4" onClick={(e) => e.stopPropagation()}>
            <Image
              src={images[lightbox]}
              alt={alt}
              fill
              sizes="100vw"
              className="object-contain"
            />
          </div>
          <p className="absolute bottom-6 text-white/70 text-sm">
            {lightbox + 1} / {images.length}
          </p>
        </div>
      )}
    </>
  );
}
