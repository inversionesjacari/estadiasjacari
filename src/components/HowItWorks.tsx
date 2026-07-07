const steps = [
  {
    n: "1",
    title: "Elegí tu propiedad",
    body: "Mirá fotos, capacidad y precio de nuestras 6 estadías en La Ceiba, Tela y Tegucigalpa.",
  },
  {
    n: "2",
    title: "Reservá tus fechas",
    body: "Elegí llegada y salida en el calendario — te mostramos el precio exacto antes de pagar.",
  },
  {
    n: "3",
    title: "Pagá seguro",
    body: "Confirmá con PayPal, directo en el sitio. Sin intermediarios ni comisiones extra.",
  },
  {
    n: "4",
    title: "Llegá y disfrutá",
    body: "Te contactamos un día antes con la dirección exacta y todo lo que necesitás saber.",
  },
];

export default function HowItWorks() {
  return (
    <section className="py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <p className="text-xs uppercase tracking-[0.2em] text-secondary mb-3">
            Simple y directo
          </p>
          <h2 className="font-display text-3xl lg:text-4xl text-primary">
            Cómo funciona
          </h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
          {steps.map((s) => (
            <div key={s.n} className="text-center">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-white font-display text-lg mb-4">
                {s.n}
              </div>
              <h3 className="font-display text-lg text-primary mb-2">
                {s.title}
              </h3>
              <p className="text-muted text-sm leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
