import Image from "next/image";
import { waUrl, waMessage } from "@/lib/whatsapp";

export default function HostCard({ propertyName }: { propertyName: string }) {
  return (
    <section className="bg-primary/5 border border-primary/10 rounded-2xl p-6 md:p-8 flex flex-col sm:flex-row items-center sm:items-start gap-5 text-center sm:text-left">
      <Image
        src="/logo.png"
        alt="Estadías Jacarí"
        width={64}
        height={64}
        className="rounded-full flex-shrink-0"
      />
      <div>
        <p className="text-xs uppercase tracking-wider text-secondary mb-1">
          Tu anfitrión
        </p>
        <h3 className="font-display text-xl text-primary mb-2">
          El equipo de Estadías Jacarí
        </h3>
        <p className="text-gray-700 leading-relaxed mb-4">
          Administramos cada propiedad directamente — nada de intermediarios.
          Te respondemos por WhatsApp en menos de 24 horas, antes, durante y
          después de tu estadía.
        </p>
        <a
          href={waUrl(waMessage.property(propertyName))}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-outline text-sm"
        >
          Escribinos por WhatsApp →
        </a>
      </div>
    </section>
  );
}
