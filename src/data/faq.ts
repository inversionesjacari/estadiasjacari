// Copia estática de kb_faqs (D1, editable desde /inbox/conocimiento) para
// la página pública /preguntas-frecuentes. Ver nota de sincronización en
// policies.ts — mismo criterio (contenido estable, SEO en el HTML).
export interface Faq {
  question: string;
  answer: string;
}

export const faqs: Faq[] = [
  {
    question: "¿A qué hora es el check-in?",
    answer:
      "El check-in es a las 3:00 PM y el check-out a las 11:00 AM. Aplica en todos nuestros alojamientos.",
  },
  {
    question: "¿Tienen WiFi?",
    answer:
      "Sí, todas las propiedades tienen WiFi de alta velocidad. Casa Brisa y Casa Marea tienen WiFi dual (2 redes).",
  },
  {
    question: "¿Tienen TV?",
    answer:
      "Sí, todas las propiedades tienen Smart TV. Conectás tu propia cuenta de streaming (Netflix, HBO, Disney+, etc.).",
  },
  {
    question: "¿Se permiten mascotas?",
    answer:
      "Sí, en la mayoría de propiedades (excepto Centro Morazán) podemos hacer una excepción. Solo te pedimos hacerte responsable por cualquier daño y comunicarlo de inmediato con nosotros.",
  },
  {
    question: "¿Hay piscina en Tela (Casa Brisa / Casa Marea)?",
    answer:
      "Hay piscina disponible, pero es un servicio opcional que se paga en el hotel: L.250 por persona de lunes a jueves, y L.350 de viernes a domingo.",
  },
  {
    question: "¿Hay piscina en Villa B11 (La Ceiba)?",
    answer:
      "Sí, el acceso a la piscina del Hotel Palma Real está incluido con la renta. Te damos brazaletes al inicio de tu estadía.",
  },
  {
    question: "¿Cómo se llega a la playa en Tela?",
    answer:
      "De dos maneras: por la playa pública rodeando el hotel (sin costo), o a través del hotel de forma más directa con el costo opcional de L.250-350 por persona.",
  },
  {
    question: "¿Se permiten fiestas o eventos?",
    answer: "No, las fiestas y eventos están prohibidos en todas nuestras propiedades.",
  },
  {
    question: "¿Cuál es la política de cancelación?",
    answer:
      "Si cancelás con al menos una semana de anticipación, te hacemos el reembolso completo. Después de esa fecha, el depósito inicial del 50% no es reembolsable.",
  },
  {
    question: "¿Hay generador eléctrico?",
    answer: "Casa Brisa y Casa Marea tienen generador eléctrico propio incluido (muy útil en la costa).",
  },
  {
    question: "¿Los precios incluyen todo?",
    answer:
      "Sí. El precio incluye el alojamiento, todas las amenidades y la tarifa de limpieza. No hay cargos ocultos.",
  },
  {
    question: "¿Cómo funciona el pago?",
    answer:
      "Se paga el 50% para confirmar la reserva y el 50% restante el día del check-in. Aceptamos tarjeta/PayPal o transferencia bancaria BAC.",
  },
];
