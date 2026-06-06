import type { Metadata } from "next";
import { DM_Serif_Display, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import SiteChrome from "@/components/SiteChrome";

// NOTE: brand font is "Le Mores" (Studio Sun, commercial license).
// Using DM Serif Display as the closest free alternative until the
// license is purchased. Swap the import and the variable to switch.
const display = DM_Serif_Display({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

const body = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Estadías Jacarí — Alquileres Temporales en Honduras",
  description:
    "Alquileres temporales en Honduras con todo lo que necesitas para sentirte en casa. Propiedades verificadas en La Ceiba, Tela y Tegucigalpa.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={`${display.variable} ${body.variable}`}>
      <body>
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}
