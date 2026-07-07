import type { Metadata } from "next";
import Link from "next/link";
import { policies } from "@/data/policies";
import { waUrl, waMessage } from "@/lib/whatsapp";

export const metadata: Metadata = {
  title: "Políticas — Estadías Jacarí",
  description:
    "Check-in, check-out, cancelación, pago y demás políticas de nuestras propiedades en Honduras.",
  alternates: { canonical: "/politicas" },
  openGraph: {
    title: "Políticas — Estadías Jacarí",
    description:
      "Check-in, check-out, cancelación, pago y demás políticas de nuestras propiedades en Honduras.",
    url: "/politicas",
    type: "website",
  },
};

export default function PoliticasPage() {
  return (
    <main className="pt-24 lg:pt-28 pb-20">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <nav className="text-sm text-muted mb-6">
          <Link href="/" className="hover:text-primary">
            Inicio
          </Link>
          <span className="mx-2">/</span>
          <span className="text-primary">Políticas</span>
        </nav>

        <header className="mb-10">
          <p className="text-xs uppercase tracking-[0.2em] text-secondary mb-3">
            Antes de reservar
          </p>
          <h1 className="font-display text-4xl lg:text-5xl text-primary mb-4">
            Políticas
          </h1>
          <p className="text-muted leading-relaxed">
            Las mismas reglas aplican a las 6 propiedades, salvo que se
            indique lo contrario.
          </p>
        </header>

        <div className="space-y-4">
          {policies.map((p) => (
            <div
              key={p.key}
              className="bg-white border border-gray-100 rounded-2xl p-5"
            >
              <h2 className="font-display text-lg text-primary mb-1">
                {p.label}
              </h2>
              <p className="text-gray-700 leading-relaxed">{p.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 text-center">
          <p className="text-gray-700 mb-4">¿Tenés otra pregunta?</p>
          <a href={waUrl(waMessage.faq())} target="_blank" rel="noopener noreferrer" className="btn-accent">
            Preguntar por WhatsApp →
          </a>
        </div>
      </div>
    </main>
  );
}
