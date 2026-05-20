import Link from "next/link";

export default function NotFound() {
  return (
    <section className="min-h-[70vh] flex items-center justify-center px-6 pt-32">
      <div className="text-center max-w-md">
        <p className="text-xs uppercase tracking-[0.2em] text-secondary mb-3">
          404
        </p>
        <h1 className="font-display text-4xl text-primary mb-4">
          Esta propiedad no existe
        </h1>
        <p className="text-muted mb-6">
          La página que buscás no está disponible o fue movida.
        </p>
        <Link href="/" className="btn-accent">
          Volver al inicio
        </Link>
      </div>
    </section>
  );
}
