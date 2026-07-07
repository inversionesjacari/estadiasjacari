import type { MetadataRoute } from "next";
import { properties } from "@/data/properties";
import { SITE_URL } from "@/lib/site";

// Con `output: 'export'` esta ruta se evalúa en build y emite out/sitemap.xml.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, priority: 1, changeFrequency: "weekly" },
    {
      url: `${SITE_URL}/propiedades`,
      priority: 0.9,
      changeFrequency: "weekly",
    },
    ...properties.map((p) => ({
      url: `${SITE_URL}/propiedades/${p.slug}`,
      priority: 0.8,
      changeFrequency: "weekly" as const,
    })),
    { url: `${SITE_URL}/politicas`, priority: 0.4, changeFrequency: "monthly" },
    {
      url: `${SITE_URL}/preguntas-frecuentes`,
      priority: 0.4,
      changeFrequency: "monthly",
    },
  ];
}
