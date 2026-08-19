import { describe, expect, it } from "vitest";
import { extractOrderIds } from "../../api/inbox/paypal-pending";

//
// INCIDENTE 2026-08-19 — "les cobran y no nos entra la plata".
//
// El bot creaba la orden con intent CAPTURE y mandaba el link de checkoutnow,
// pero NADIE llamaba nunca a /capture: el return_url apuntaba a /gracias, que ni
// existía. La orden quedaba APPROVED → retención visible en la tarjeta del
// huésped (por eso juraba haber pagado), plata que nunca entra, ningún
// PAYMENT.CAPTURE.COMPLETED y el bot repitiendo "esperando la confirmación".
//
// La invariante que fija este archivo: sabemos RECONOCER los links de pago que
// mandó el bot, que es lo que permite ir a buscar la plata colgada. El cobro en
// sí lo cubre PayPal (idempotencia por PayPal-Request-Id + ORDER_ALREADY_CAPTURED).
//

describe("extractOrderIds — encontrar la plata colgada en los links ya enviados", () => {
  it("saca el order id del mensaje real que manda el bot", () => {
    const real = `¡Listo! El 50% de depósito es HNL 2,675 (≈ USD 97.00). Pagás acá:

👉 https://www.paypal.com/checkoutnow?token=8P177164DA917144M

Al confirmar el pago recibís automáticamente tu confirmación de reserva por correo ✅`;
    expect(extractOrderIds(real)).toEqual(["8P177164DA917144M"]);
  });

  it("reconoce varios links en un mismo hilo (reenvíos)", () => {
    const body = "link 1 checkoutnow?token=4BJ71012C97136148 y link 2 checkoutnow?token=8P177164DA917144M";
    expect(extractOrderIds(body)).toEqual(["4BJ71012C97136148", "8P177164DA917144M"]);
  });

  it("no inventa ids donde no hay link de pago", () => {
    expect(extractOrderIds("Te paso los datos de la transferencia BAC")).toEqual([]);
    expect(extractOrderIds(null)).toEqual([]);
    expect(extractOrderIds("")).toEqual([]);
  });

  it("ignora otros links de paypal que no son de cobro", () => {
    expect(extractOrderIds("https://www.paypal.com/mi-cuenta")).toEqual([]);
  });
});
