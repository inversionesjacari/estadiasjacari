"use client";
//
// Analytics — beacon liviano de visitas, privacy-friendly (sin cookies).
// Llama a /api/track en cada cambio de página. No rastrea el panel /inbox (admin).
//

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export default function Analytics() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    // No contar las vistas del panel admin como tráfico del sitio.
    if (pathname.startsWith("/inbox")) return;

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

    try {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathname, referrer }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }, [pathname]);

  return null;
}
