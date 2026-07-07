import type { Property } from "@/data/properties";
import { SITE_URL, SITE_NAME } from "@/lib/site";

// Builders puros para schema.org JSON-LD. Cada uno devuelve un objeto plano
// listo para JSON.stringify vía <JsonLd />.

export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/logo.png`,
    sameAs: [
      "https://www.facebook.com/profile.php?id=100078132980551",
      "https://www.instagram.com/estadiasjacari",
    ],
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer service",
      telephone: "+504-8839-0145",
      areaServed: "HN",
      availableLanguage: "Spanish",
    },
  };
}

export function lodgingBusinessSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "LodgingBusiness",
    name: SITE_NAME,
    url: SITE_URL,
    image: `${SITE_URL}/og-image.jpg`,
    areaServed: ["La Ceiba", "Tela", "Tegucigalpa"],
    priceRange: "L 650 – L 2,500 por noche",
    checkinTime: "15:00",
    checkoutTime: "11:00",
  };
}

export function vacationRentalSchema(
  property: Property,
  agg?: { ratingValue: number; reviewCount: number } | null
) {
  const url = `${SITE_URL}/propiedades/${property.slug}`;
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "VacationRental",
    name: property.name,
    description: property.description[0],
    url,
    image: property.images.map((img) => `${SITE_URL}${img}`),
    address: {
      "@type": "PostalAddress",
      addressLocality: property.city,
      addressCountry: "HN",
    },
    numberOfBedrooms: property.bedrooms.length,
    numberOfBathroomsTotal: property.bathrooms,
    occupancy: {
      "@type": "QuantitativeValue",
      value: property.capacity,
    },
    checkinTime: "15:00",
    checkoutTime: "11:00",
    petsAllowed: false,
  };

  if (agg) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: agg.ratingValue,
      reviewCount: agg.reviewCount,
    };
  }

  return schema;
}

export function breadcrumbSchema(items: { name: string; url: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.url}`,
    })),
  };
}

export function faqPageSchema(faqs: { question: string; answer: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: f.answer,
      },
    })),
  };
}
