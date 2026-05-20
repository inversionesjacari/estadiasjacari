const items = [
  {
    title: "Propiedades verificadas y equipadas",
    body: "Cada propiedad está lista al llegar — cocina, ropa de cama, WiFi y todo lo necesario para sentirte en casa desde el primer día.",
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
        <path
          d="M5 12l5 5L20 7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Atención personalizada",
    body: "Tratamos cada reserva como única. Respondemos por WhatsApp en menos de 24 horas y resolvemos lo que necesites antes, durante y después de tu estadía.",
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
        <path
          d="M21 11.5c0 4.694-4.03 8.5-9 8.5a9.5 9.5 0 0 1-3.4-.625L4 21l1.4-3.85A8.18 8.18 0 0 1 3 11.5C3 6.806 7.03 3 12 3s9 3.806 9 8.5Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Comprometidos con tu experiencia",
    body: "Queremos que vuelvas — por eso cuidamos cada detalle, desde la limpieza hasta las recomendaciones locales, para que tu estadía sea memorable.",
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.5-7 10-7 10Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

export default function WhyUs() {
  return (
    <section className="py-20 lg:py-24 bg-primary text-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <p className="text-xs uppercase tracking-[0.2em] text-accent mb-3">
            Por qué Jacarí
          </p>
          <h2 className="font-display text-4xl lg:text-5xl text-white">
            Más que un alquiler
          </h2>
        </div>
        <div className="grid md:grid-cols-3 gap-8 lg:gap-12">
          {items.map((it) => (
            <div key={it.title} className="text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-accent/15 text-accent mb-4">
                {it.icon}
              </div>
              <h3 className="font-display text-xl text-white mb-2">
                {it.title}
              </h3>
              <p className="text-white/75 text-sm leading-relaxed">
                {it.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
