import { waUrl, waMessage } from "@/lib/whatsapp";

export default function ContactCTA() {
  const whatsapp = waUrl(waMessage.generic());

  return (
    <section id="contacto" className="py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="bg-white border border-gray-100 rounded-3xl p-8 md:p-12 text-center shadow-card">
          <p className="text-xs uppercase tracking-[0.2em] text-secondary mb-3">
            Contacto
          </p>
          <h2 className="font-display text-3xl lg:text-4xl text-primary mb-4">
            ¿Conversamos sobre tu próxima escapada?
          </h2>
          <p className="text-muted max-w-xl mx-auto mb-8">
            Escribinos por WhatsApp y te contactamos en menos de 24 horas con
            disponibilidad y tarifas. Estamos en Honduras 🇭🇳.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href={whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-accent"
            >
              Escribir por WhatsApp
            </a>
            <a href="mailto:hola@estadiasjacari.com" className="btn-outline">
              Enviar correo
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
