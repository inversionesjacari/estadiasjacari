"use client";
//
// SiteChrome — wrapper que decide qué partes del layout público se renderizan
// según la ruta.
//
// Sitio público (/, /propiedades/*) → Navbar + Footer + botón flotante WhatsApp
// Dashboards admin (/inbox)         → solo <main> sin distracciones
//
// Esto deja el dashboard /inbox a pantalla completa (sin el navbar fijo
// que tapaba la primera conversación) y sin el botón flotante de WhatsApp
// que enviaba al mismo número que estás operando.
//
// Si se agregan más rutas admin en el futuro (ej. /admin, /reports), añadirlas
// a `ADMIN_PREFIXES`.
//

import { usePathname } from "next/navigation";
import Navbar from "./Navbar";
import Footer from "./Footer";
import WhatsAppButton from "./WhatsAppButton";

const ADMIN_PREFIXES = ["/inbox"];

export default function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const isAdmin = ADMIN_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (isAdmin) {
    return <main>{children}</main>;
  }

  return (
    <>
      <Navbar />
      <main>{children}</main>
      <Footer />
      <WhatsAppButton />
    </>
  );
}
