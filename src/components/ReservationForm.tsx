"use client";

import { useState } from "react";

interface Props {
  propertyName: string;
}

export default function ReservationForm({ propertyName }: Props) {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    // No backend wired up yet — simulate latency for feedback.
    await new Promise((r) => setTimeout(r, 600));
    setSubmitting(false);
    setSubmitted(true);
  };

  const whatsapp =
    "https://wa.me/50488390145?text=" +
    encodeURIComponent(
      `Hola, me interesa la propiedad ${propertyName} de Estadías Jacarí.`
    );

  if (submitted) {
    return (
      <div className="bg-white border border-secondary/40 rounded-2xl p-6 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-secondary/15 text-secondary mb-3">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12l5 5L20 7"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h3 className="font-display text-xl text-primary mb-2">¡Gracias!</h3>
        <p className="text-sm text-muted mb-4">
          Te contactaremos en menos de 24 horas con la información de{" "}
          <strong>{propertyName}</strong>.
        </p>
        <a
          href={whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-accent w-full"
        >
          Hablar por WhatsApp ahora
        </a>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white border border-gray-100 rounded-2xl p-6 shadow-card"
    >
      <h3 className="font-display text-xl text-primary mb-1">
        ¿Te interesa esta propiedad?
      </h3>
      <p className="text-sm text-muted mb-5">
        Te contactamos en menos de 24 horas.
      </p>

      <div className="space-y-3">
        <Field label="Nombre" name="name" type="text" required />
        <Field label="Email" name="email" type="email" required />
        <Field label="Teléfono / WhatsApp" name="phone" type="tel" required />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Check-in" name="checkin" type="date" />
          <Field label="Check-out" name="checkout" type="date" />
        </div>

        <Field
          label="Huéspedes"
          name="guests"
          type="number"
          min={1}
          max={20}
          defaultValue={2}
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="btn-accent w-full mt-6 disabled:opacity-60"
      >
        {submitting ? "Enviando…" : "Solicitar información"}
      </button>

      <p className="text-xs text-muted text-center mt-3">
        o escribinos directo por{" "}
        <a
          href={whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="text-secondary underline"
        >
          WhatsApp
        </a>
      </p>
    </form>
  );
}

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

function Field({ label, ...rest }: FieldProps) {
  return (
    <label className="block">
      <span className="block text-xs text-muted mb-1">{label}</span>
      <input
        {...rest}
        className="w-full bg-bg border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-secondary focus:bg-white transition"
      />
    </label>
  );
}
