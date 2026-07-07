// Cliente del beacon de eventos del embudo (POST /api/track-event).
// Misma exclusión de dueño que components/Analytics.tsx (localStorage
// "jacari_owner"). Usa sendBeacon cuando está disponible — sigue enviando
// aunque el usuario navegue a otra página justo después del click.
export type SiteEvent =
  | "whatsapp_click"
  | "booking_widget_open"
  | "dates_selected"
  | "checkout_review"
  | "paypal_shown"
  | "booking_success";

export function trackEvent(
  event: SiteEvent,
  opts?: { propertySlug?: string; meta?: Record<string, unknown> },
) {
  try {
    if (localStorage.getItem("jacari_owner") === "1") return;
  } catch {
    /* localStorage no disponible → seguir */
  }

  const payload = JSON.stringify({
    event,
    propertySlug: opts?.propertySlug,
    path: window.location.pathname,
    meta: opts?.meta,
  });

  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/track-event",
        new Blob([payload], { type: "application/json" }),
      );
    } else {
      fetch("/api/track-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* nunca romper la UI por un beacon */
  }
}
