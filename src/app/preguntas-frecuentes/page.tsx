import type { Metadata } from "next";
import Link from "next/link";
import { faqs } from "@/data/faq";
import { waUrl, waMessage } from "@/lib/whatsapp";
import JsonLd from "@/components/JsonLd";
import { faqPageSchema } from "@/lib/schema";

export const metadata: Metadata = {
  title: "Preguntas frecuentes — Estadías Jacarí",
  description:
    "WiFi, mascotas, piscina, cancelación, forma de pago y más — respuestas rápidas antes de reservar.",
  alternates: { canonical: "/preguntas-frecuentes" },
  openGraph: {
    title: "Preguntas frecuentes — Estadías Jacarí",
    description:
      "WiFi, mascotas, piscina, cancelación, forma de pago y más — respuestas rápidas antes de reservar.",
    url: "/preguntas-frecuentes",
    type: "website",
  },
};

export default function FaqPage() {
  return (
    <main className="pt-24 lg:pt-28 pb-20">
      <JsonLd data={faqPageSchema(faqs)} />
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <nav className="text-sm text-muted mb-6">
          <Link href="/" className="hover:text-primary">
            Inicio
          </Link>
          <span className="mx-2">/</span>
          <span className="text-primary">Preguntas frecuentes</span>
        </nav>

        <header className="mb-10">
          <p className="text-xs uppercase tracking-[0.2em] text-secondary mb-3">
            Antes de reservar
          </p>
          <h1 className="font-display text-4xl lg:text-5xl text-primary mb-4">
            Preguntas frecuentes
          </h1>
        </header>

        <div className="space-y-3">
          {faqs.map((f) => (
            <details
              key={f.question}
              className="group bg-white border border-gray-100 rounded-2xl p-5 open:shadow-card"
            >
              <summary className="font-display text-lg text-primary cursor-pointer list-none flex items-center justify-between gap-4">
                {f.question}
                <span className="text-secondary transition group-open:rotate-45 text-2xl leading-none">
                  +
                </span>
              </summary>
              <p className="text-gray-700 leading-relaxed mt-3">{f.answer}</p>
            </details>
          ))}
        </div>

        <div className="mt-10 text-center">
          <p className="text-gray-700 mb-4">¿No encontraste tu respuesta?</p>
          <a href={waUrl(waMessage.faq())} target="_blank" rel="noopener noreferrer" className="btn-accent">
            Preguntar por WhatsApp →
          </a>
        </div>
      </div>
    </main>
  );
}
