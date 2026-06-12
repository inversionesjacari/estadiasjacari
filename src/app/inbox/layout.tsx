import type { Metadata, Viewport } from "next";
import PwaRegister from "@/components/PwaRegister";

// Convierte el inbox en una app instalable (PWA): ícono propio en la pantalla
// de inicio y pantalla completa sin barra de navegador. El alcance (scope) es
// solo /inbox/*, así que el sitio público (homepage, propiedades) NO cambia ni
// se vuelve "instalable".
export const metadata: Metadata = {
  title: "Inbox Jacarí",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Jacarí", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Coincide con el header del inbox (blanco). En modo noche, el inbox lo cambia
  // a slate-800 por JS. Evita la "línea" navy entre la barra de estado y el header.
  themeColor: "#ffffff",
};

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <PwaRegister />
    </>
  );
}
