"use client";
//
// Analytics — beacon liviano de visitas, privacy-friendly (sin cookies de terceros).
// Llama a /api/track en cada cambio de página. No rastrea el panel /inbox (admin).
//
// - Excluir al DUEÑO: entrá una vez a estadiasjacari.com/?soy_owner=1 en tu
//   dispositivo → se marca en localStorage y tus visitas dejan de contarse.
//   (Para reactivar el conteo: /?soy_owner=0.)
// - ATRIBUCIÓN: captura utm_source/medium/campaign de la URL (los pone la pauta)
//   porque el referrer solo no es confiable (FB/IG ocultan el origen).
//

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export default function Analytics() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    // No contar las vistas del panel admin como tráfico del sitio.
    if (pathname.startsWith("/inbox")) return;

    // Excluir al dueño: ?soy_owner=1 marca el dispositivo; ?soy_owner=0 lo desmarca.
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get("soy_owner") === "1") localStorage.setItem("jacari_owner", "1");
      if (sp.get("soy_owner") === "0") localStorage.removeItem("jacari_owner");
      if (localStorage.getItem("jacari_owner") === "1") return; // no contar mis visitas
    } catch {
      /* localStorage no disponible → seguir rastreando normal */
    }

    let referrer = "";
    try {
      if (document.referrer) {
        const u = new URL(document.referrer);
        // Solo dominios externos (no navegación interna del propio sitio).
        if (u.hostname !== window.location.hostname) referrer = u.hostname;
      }
    } catch {
      /* ignore */
    }

    // UTM de la URL — los pone la pauta (?utm_source=instagram&utm_medium=paid...).
    // Solo la página de aterrizaje los trae; las navegaciones internas no.
    let utmSource = "", utmMedium = "", utmCampaign = "";
    try {
      const sp = new URLSearchParams(window.location.search);
      utmSource = sp.get("utm_source") ?? "";
      utmMedium = sp.get("utm_medium") ?? "";
      utmCampaign = sp.get("utm_campaign") ?? "";
    } catch {
      /* ignore */
    }

    try {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathname, referrer, utmSource, utmMedium, utmCampaign }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }, [pathname]);

  return null;
}
