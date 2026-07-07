import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Con `output: 'export'` esta ruta se evalúa en build y emite out/robots.txt.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/inbox", "/api"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
