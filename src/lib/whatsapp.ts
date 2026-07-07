// Punto único para el número de WhatsApp y los mensajes pre-rellenados.
// Antes estaba duplicado (número + texto genérico) en 5+ componentes, y
// ningún botón decía qué propiedad estaba mirando el visitante.
//
// Todos los mensajes arrancan con el mismo marcador ("vengo del sitio web")
// para que el bot/staff sepan que el lead viene de la web y no de un
// contacto orgánico — es el mecanismo de atribución web→WhatsApp (sin UTM).
export const WHATSAPP_NUMBER = "50488390145";

export function waUrl(message: string): string {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

const INTRO = "Hola, vengo del sitio web de Estadías Jacarí";

export const waMessage = {
  generic: () => `${INTRO} y quiero información de una propiedad.`,
  property: (name: string) => `${INTRO} — me interesa ${name}. ¿Está disponible?`,
  gemelas: () =>
    `${INTRO} — me interesa Las Gemelas de Tela (Casa Brisa + Casa Marea) para mi grupo.`,
  chooseProperty: () => `${INTRO} y quiero ayuda para elegir una propiedad.`,
  faq: () => `${INTRO} y tengo una pregunta antes de reservar.`,
  unavailable: (name: string) =>
    `${INTRO} — quiero reservar ${name} pero el calendario del sitio no carga. ¿Pueden ayudarme?`,
  bookingSuccess: (opts: {
    propertyName: string;
    checkIn: string;
    checkOut: string;
    guestName: string;
    orderId: string;
  }) =>
    `¡Hola! Vengo del sitio web — acabo de confirmar mi reserva en ${opts.propertyName} del ${opts.checkIn} al ${opts.checkOut}. ` +
    `Mi nombre es ${opts.guestName}. Número de orden PayPal: ${opts.orderId}`,
};
