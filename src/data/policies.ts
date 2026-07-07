// Copia estática de kb_policies (D1, editable desde /inbox/conocimiento)
// para la página pública /politicas. El sitio es export estático — se
// preferió esto a un fetch client-side porque el contenido debe quedar en
// el HTML (SEO) y las políticas cambian con poca frecuencia.
//
// Última sincronización manual: 2026-07-06 (spot-check contra D1 real —
// la de mascotas fue editada desde el seed original para excluir a Centro
// Morazán). Si volvés a editar algo en /inbox/conocimiento, avisale a
// Claude para actualizar este archivo y hacer deploy.
export interface Policy {
  key: string;
  label: string;
  value: string;
}

export const policies: Policy[] = [
  { key: "check_in", label: "Check-in", value: "3:00 PM (aplica en todos los alojamientos)" },
  { key: "check_out", label: "Check-out", value: "11:00 AM (aplica en todos los alojamientos)" },
  {
    key: "pets",
    label: "Mascotas",
    value:
      "Se permiten en todas las propiedades, excepto en Centro Morazán. Por esta ocasión podemos hacer una excepción — solo le solicitamos a nuestros huéspedes hacerse responsables por cualquier daño que puedan llegar a ocasionar y comunicarlo de inmediato con nosotros.",
  },
  { key: "parties", label: "Fiestas y eventos", value: "Prohibidos en todas las propiedades sin excepción." },
  { key: "smoking", label: "Fumar", value: "No se permite fumar dentro de las propiedades." },
  {
    key: "cancellation",
    label: "Cancelación",
    value:
      "Reembolso completo si cancelás con al menos 1 semana de anticipación. Sin eso, el 50% inicial de depósito no es reembolsable — el 50% restante simplemente no se cobra.",
  },
  {
    key: "payment",
    label: "Forma de pago",
    value:
      "50% para reservar + 50% el día de check-in. Aceptamos tarjeta de crédito / PayPal (link inmediato) o transferencia bancaria BAC (HNL o USD).",
  },
  {
    key: "streaming",
    label: "Streaming / TV",
    value:
      "Todas las propiedades tienen Smart TV. Conectás tu propia cuenta (Netflix, HBO, Disney+, etc.) — no incluimos suscripciones.",
  },
  {
    key: "address",
    label: "Dirección exacta",
    value: "Se comparte únicamente al confirmar la reserva con el 50% de depósito.",
  },
];
