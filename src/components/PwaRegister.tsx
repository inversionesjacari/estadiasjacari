"use client";

import { useEffect } from "react";

/**
 * Registra el service worker del inbox (scope /inbox) para que sea instalable
 * como app en la pantalla de inicio. Best-effort: si el navegador no soporta
 * service workers (o falla el registro), el inbox sigue funcionando igual como
 * web normal — solo no aparece la opción de "instalar".
 */
export default function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/inbox" })
      .catch(() => {
        /* sin SW el inbox sigue andando; solo no se "instala" */
      });
  }, []);
  return null;
}
